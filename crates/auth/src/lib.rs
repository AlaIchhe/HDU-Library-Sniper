//! 登录与会话编排：SSO 账密、openid、扫码登录、持久化与自动刷新。

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use chrono::{SecondsFormat, Utc};
use hdu_sniper_core::{QrLoginStart, QrLoginStatus, SessionStatus};
use hdu_sniper_hdu::{
    encrypt_password, extract_openid, CookieJar, HduError, LibraryClient, RefreshHandler,
    StoredCookie, LIBRARY_BASE, LOGIN_ENTRY, OPENID_USER_AGENT, SSO_BASE, SSO_CSRF_KEY,
    SSO_CSRF_VALUE, USER_AGENT,
};
use hdu_sniper_store::{SessionRow, Store, StoreError};
use regex::Regex;
use reqwest::header::{ACCEPT, COOKIE, LOCATION, USER_AGENT as HEADER_USER_AGENT};
use reqwest::{Client, Method, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Semaphore;
use url::Url;

mod secrets;
pub use secrets::{default_store, AesSecretStore, SecretStore};

#[derive(Debug, Clone)]
pub struct Endpoints {
    pub library: String,
    pub login_entry: String,
    pub sso: String,
    pub sso_login_page: String,
    pub sso_csrf_script: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            library: LIBRARY_BASE.to_string(),
            login_entry: LOGIN_ENTRY.to_string(),
            sso: SSO_BASE.to_string(),
            sso_login_page: format!(
                "{SSO_BASE}/login?service={}",
                urlencoding::encode(LOGIN_ENTRY)
            ),
            sso_csrf_script: format!("{SSO_BASE}/public/utils/loginNew.js"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// 登录结果，message 直接展示给用户。
pub struct LoginResult {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("database: {0}")]
    Store(#[from] StoreError),
    #[error("hdu: {0}")]
    Hdu(#[from] HduError),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Invalid(String),
    #[error("busy")]
    Busy,
}

#[derive(Debug, Clone)]
struct Credentials {
    student_id: String,
    password: String,
}

#[derive(Debug, Clone)]
struct Csrf {
    key: String,
    value: String,
}

impl Default for Csrf {
    fn default() -> Self {
        Self {
            key: SSO_CSRF_KEY.to_string(),
            value: SSO_CSRF_VALUE.to_string(),
        }
    }
}

#[derive(Clone)]
struct SessionSnapshot {
    cookies: Vec<StoredCookie>,
    uid: String,
    name: String,
    credentials: Option<Credentials>,
    openid: Option<String>,
}

struct LoginGuard {
    failures: u32,
    blocked_until: Option<Instant>,
}

#[derive(Clone)]
struct QrSession {
    created_at: i64,
    status: String,
    message: Option<String>,
    session: Option<SessionStatus>,
}

/// 登录态与凭据编排：SSO/扫码登录、持久化、后台刷新。
pub struct AuthService {
    store: Arc<Store>,
    pub client: LibraryClient,
    auth_http: Client,
    auth_jar: Mutex<CookieJar>,
    credentials: Mutex<Option<Credentials>>,
    openid: Mutex<Option<String>>,
    csrf: Mutex<Csrf>,
    qr_sessions: Mutex<HashMap<String, QrSession>>,
    qr_slots: Arc<Semaphore>,
    login_guard: Mutex<LoginGuard>,
    secrets: Option<Box<dyn SecretStore>>,
    endpoints: Endpoints,
    refreshing: AtomicBool,
}

impl AuthService {
    pub fn new(store: Arc<Store>) -> Result<Self, AuthError> {
        Self::with_endpoints(store, Endpoints::default())
    }

    pub fn with_endpoints(store: Arc<Store>, endpoints: Endpoints) -> Result<Self, AuthError> {
        Self::with_endpoints_and_secrets(store, endpoints, default_store())
    }

    pub fn with_endpoints_and_secrets(
        store: Arc<Store>,
        endpoints: Endpoints,
        secrets: Option<Box<dyn SecretStore>>,
    ) -> Result<Self, AuthError> {
        let session = store.load_session()?;
        let mut credentials = None;
        let mut openid = None;
        let mut cookies = Vec::new();
        let mut uid = String::new();
        let mut name = String::new();
        let mut legacy_plaintext = false;
        if let Some(row) = session {
            legacy_plaintext = row.credentials_enc.is_empty()
                && (!row.password.is_empty() || !row.openid.is_empty());
            if !row.credentials_enc.is_empty() {
                match secrets.as_ref() {
                    Some(secrets) => match secrets.open(&row.credentials_enc).and_then(|blob| {
                        serde_json::from_str::<Value>(&blob).map_err(AuthError::from)
                    }) {
                        Ok(value) => {
                            let student_id = value
                                .get("student_id")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            let password = value
                                .get("password")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            if !student_id.is_empty() && !password.is_empty() {
                                credentials = Some(Credentials {
                                    student_id,
                                    password,
                                });
                            }
                            let saved_openid = value
                                .get("openid")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            if !saved_openid.is_empty() {
                                openid = Some(saved_openid);
                            }
                        }
                        Err(error) => {
                            tracing::warn!(%error, "凭据解密失败，按未登录处理");
                        }
                    },
                    None => tracing::warn!("数据库中存在加密凭据，但当前没有可用密钥"),
                }
            } else {
                if !row.student_id.is_empty() && !row.password.is_empty() {
                    credentials = Some(Credentials {
                        student_id: row.student_id,
                        password: row.password,
                    });
                }
                if !row.openid.is_empty() {
                    openid = Some(row.openid);
                }
            }
            cookies = serde_json::from_str::<Vec<StoredCookie>>(&row.cookies).unwrap_or_default();
            uid = row.uid;
            name = row.name;
        }
        let client = LibraryClient::with_base_url(&endpoints.library)?;
        client.replace_cookies(cookies.clone());
        client.set_identity(uid, name);
        let auth_http = Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| AuthError::Invalid(error.to_string()))?;
        let service = Self {
            store,
            client,
            auth_http,
            auth_jar: Mutex::new(CookieJar::new(cookies)),
            credentials: Mutex::new(credentials),
            openid: Mutex::new(openid),
            csrf: Mutex::new(Csrf::default()),
            qr_sessions: Mutex::new(HashMap::new()),
            qr_slots: Arc::new(Semaphore::new(2)),
            login_guard: Mutex::new(LoginGuard {
                failures: 0,
                blocked_until: None,
            }),
            secrets,
            endpoints,
            refreshing: AtomicBool::new(false),
        };
        if legacy_plaintext && service.secrets.is_some() {
            if let Err(error) = service.persist_now() {
                tracing::warn!(%error, "迁移明文凭据失败");
            }
        }
        Ok(service)
    }

    pub fn authenticated(&self) -> bool {
        !self.client.uid().is_empty()
    }

    pub fn status(&self) -> SessionStatus {
        let uid = self.client.uid();
        let name = self.client.name();
        SessionStatus {
            authenticated: !uid.is_empty(),
            uid: (!uid.is_empty()).then_some(uid),
            name: (!name.is_empty()).then_some(name),
            refreshing: false,
            last_error: None,
        }
    }

    fn clear_state(&self) {
        self.auth_jar.lock().expect("auth jar poisoned").clear();
        self.client.clear_cookies();
        self.client.set_identity(String::new(), String::new());
    }

    fn sync_cookies_to_client(&self) {
        let cookies = self.auth_jar.lock().expect("auth jar poisoned").all();
        self.client.replace_cookies(cookies);
    }

    fn persist_now(&self) -> Result<(), AuthError> {
        let credentials = self
            .credentials
            .lock()
            .expect("credentials poisoned")
            .clone();
        let openid = self.openid.lock().expect("openid poisoned").clone();
        let cookies = serde_json::to_string(&self.client.jar_snapshot().all())?;
        let mut row = SessionRow {
            uid: self.client.uid(),
            name: self.client.name(),
            student_id: String::new(),
            password: String::new(),
            openid: String::new(),
            cookies,
            updated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            credentials_enc: String::new(),
            credentials_scheme: "plain".into(),
        };
        match self.secrets.as_ref() {
            Some(secrets) if credentials.is_some() || openid.is_some() => {
                let blob = serde_json::to_string(&json!({
                    "student_id": credentials
                        .as_ref()
                        .map(|value| value.student_id.as_str())
                        .unwrap_or_default(),
                    "password": credentials
                        .as_ref()
                        .map(|value| value.password.as_str())
                        .unwrap_or_default(),
                    "openid": openid.as_deref().unwrap_or_default(),
                }))?;
                row.credentials_enc = secrets.seal(&blob)?;
                row.credentials_scheme = secrets.scheme().to_string();
            }
            Some(_) => {}
            None => {
                row.student_id = credentials
                    .as_ref()
                    .map(|value| value.student_id.clone())
                    .unwrap_or_default();
                row.password = credentials
                    .as_ref()
                    .map(|value| value.password.clone())
                    .unwrap_or_default();
                row.openid = openid.unwrap_or_default();
            }
        }
        self.store.save_session(&row)?;
        Ok(())
    }

    async fn persist(&self) -> Result<(), AuthError> {
        self.persist_now()
    }

    async fn follow(
        &self,
        url: &str,
        method: Method,
        headers: Vec<(String, String)>,
        form: Option<Vec<(String, String)>>,
    ) -> Result<Response, AuthError> {
        let mut current = Url::parse(url).map_err(|error| AuthError::Invalid(error.to_string()))?;
        let mut current_method = method;
        let mut current_form = form;
        for _ in 0..10 {
            let cookie = self
                .auth_jar
                .lock()
                .expect("auth jar poisoned")
                .header_for(current.as_str());
            let mut request = self
                .auth_http
                .request(current_method.clone(), current.clone());
            for (key, value) in &headers {
                request = request.header(key, value);
            }
            if !cookie.is_empty() {
                request = request.header(COOKIE, cookie);
            }
            if let Some(form) = current_form.as_ref() {
                request = request.form(form);
            }
            let response = request.send().await.map_err(|error| {
                if error.is_timeout() {
                    HduError::RequestTimeout
                } else {
                    HduError::Network(error.to_string())
                }
            })?;
            self.auth_jar
                .lock()
                .expect("auth jar poisoned")
                .merge_headers(response.headers(), current.as_str());
            let status = response.status();
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let Some(location) = location else {
                return Ok(response);
            };
            if !matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            current = current
                .join(&location)
                .map_err(|error| AuthError::Invalid(error.to_string()))?;
            if status == reqwest::StatusCode::SEE_OTHER
                || (status == reqwest::StatusCode::FOUND && current_method == Method::POST)
            {
                current_method = Method::GET;
                current_form = None;
            }
        }
        Err(AuthError::Invalid("SSO 重定向次数过多".into()))
    }

    async fn login_password_inner(
        &self,
        student_id: &str,
        password: &str,
    ) -> Result<LoginResult, String> {
        let response = self
            .follow(
                &self.endpoints.login_entry,
                Method::GET,
                vec![(HEADER_USER_AGENT.to_string(), USER_AGENT.to_string())],
                None,
            )
            .await
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Ok(LoginResult {
                success: false,
                message: format!("登录入口不可用: {}", response.status()),
            });
        }
        let final_url = response.url().clone();
        let html = response.text().await.map_err(|error| error.to_string())?;
        let key = first_capture(
            &html,
            &[
                r#"id=["']login-croypto["'][^>]*>([^<]+)<"#,
                r#"id=["']login-croypto["'][^>]*value=["']([^"']+)"#,
            ],
        )
        .ok_or_else(|| "SSO 页面缺少登录参数".to_string())?;
        let execution = first_capture(
            &html,
            &[
                r#"id=["']login-page-flowkey["'][^>]*>([^<]+)<"#,
                r#"id=["']login-page-flowkey["'][^>]*value=["']([^"']+)"#,
                r#"name=["']execution["'][^>]*value=["']([^"']+)"#,
            ],
        )
        .ok_or_else(|| "SSO 页面缺少登录参数".to_string())?;
        let action = first_capture(
            &html,
            &[r#"<form[^>]+id=["']normalLoginForm["'][^>]+action=["']([^"']+)"#],
        )
        .unwrap_or_else(|| "/login".to_string());
        let action_url = final_url.join(&action).map_err(|error| error.to_string())?;
        let encrypted = encrypt_password(&key, password)?;
        let captcha = encrypt_password(&key, "{}")?;
        let form = vec![
            ("username".into(), student_id.to_string()),
            ("type".into(), "UsernamePassword".into()),
            ("_eventId".into(), "submit".into()),
            ("execution".into(), execution),
            ("croypto".into(), key),
            ("password".into(), encrypted),
            ("captcha_payload".into(), captcha),
        ];
        let response = self
            .follow(
                action_url.as_str(),
                Method::POST,
                vec![(HEADER_USER_AGENT.to_string(), USER_AGENT.to_string())],
                Some(form),
            )
            .await
            .map_err(|error| error.to_string())?;
        if response.url().as_str().starts_with(&self.endpoints.sso) {
            return Ok(LoginResult {
                success: false,
                message: "SSO 登录失败，请核对凭据或稍后重试".into(),
            });
        }
        self.sync_cookies_to_client();
        if !self.client.validate().await || self.client.uid().is_empty() {
            return Ok(LoginResult {
                success: false,
                message: "Cookie 无效或登录态未生效".into(),
            });
        }
        *self.openid.lock().expect("openid poisoned") = None;
        self.persist().await.map_err(|error| error.to_string())?;
        let name = self.client.name();
        Ok(LoginResult {
            success: true,
            message: if name.is_empty() {
                "认证成功".into()
            } else {
                format!("认证成功：{name}")
            },
        })
    }

    pub async fn login_password(&self, student_id: &str, password: &str) -> LoginResult {
        if student_id.trim().is_empty() || password.is_empty() {
            return LoginResult {
                success: false,
                message: "请输入学号和密码".into(),
            };
        }
        if let Some(remaining) = self.login_blocked() {
            return LoginResult {
                success: false,
                message: format!("尝试次数过多，请 {remaining} 秒后再试"),
            };
        }
        *self.credentials.lock().expect("credentials poisoned") = Some(Credentials {
            student_id: student_id.to_string(),
            password: password.to_string(),
        });
        let result = match self.login_password_inner(student_id, password).await {
            Ok(result) => result,
            Err(error) => LoginResult {
                success: false,
                message: format!("登录请求失败：{error}"),
            },
        };
        self.note_login(result.success);
        result
    }

    fn login_blocked(&self) -> Option<u64> {
        let guard = self.login_guard.lock().expect("login guard poisoned");
        let until = guard.blocked_until?;
        let now = Instant::now();
        (until > now).then(|| until.duration_since(now).as_secs() + 1)
    }

    fn note_login(&self, success: bool) {
        let mut guard = self.login_guard.lock().expect("login guard poisoned");
        if success {
            guard.failures = 0;
            guard.blocked_until = None;
            return;
        }
        guard.failures += 1;
        if guard.failures >= 3 {
            guard.failures = 0;
            guard.blocked_until = Some(Instant::now() + Duration::from_secs(30));
        }
    }

    async fn exchange_openid(&self, openid: &str) -> Result<(), HduError> {
        let url = format!(
            "{}/content/index/startUp/openid/{}/",
            self.endpoints.library,
            urlencoding::encode(openid)
        );
        let response = self
            .follow(
                &url,
                Method::GET,
                vec![
                    (HEADER_USER_AGENT.to_string(), OPENID_USER_AGENT.to_string()),
                    (
                        ACCEPT.to_string(),
                        "text/html,application/xhtml+xml,*/*".to_string(),
                    ),
                ],
                None,
            )
            .await
            .map_err(|error| match error {
                AuthError::Hdu(error) => error,
                other => HduError::Library(other.to_string()),
            })?;
        if response.url().as_str().starts_with(&self.endpoints.sso) {
            return Err(HduError::Library(
                "openid 无效：被重定向到统一认证登录".into(),
            ));
        }
        if !response.status().is_success() {
            return Err(HduError::Http(response.status().as_u16()));
        }
        self.sync_cookies_to_client();
        if !self.client.validate().await || self.client.uid().is_empty() {
            return Err(HduError::Library("openid 无效或登录态未生效".into()));
        }
        Ok(())
    }

    pub async fn login_with_openid(&self, raw: &str) -> LoginResult {
        let openid = extract_openid(raw);
        if openid.is_empty() {
            return LoginResult {
                success: false,
                message: "请输入有效的 openid 或微信端登录链接".into(),
            };
        }
        let snapshot = SessionSnapshot {
            cookies: self.client.jar_snapshot().all(),
            uid: self.client.uid(),
            name: self.client.name(),
            credentials: self
                .credentials
                .lock()
                .expect("credentials poisoned")
                .clone(),
            openid: self.openid.lock().expect("openid poisoned").clone(),
        };
        self.clear_state();
        *self.credentials.lock().expect("credentials poisoned") = None;
        let result = self.exchange_openid(&openid).await;
        match result {
            Ok(()) => {
                *self.openid.lock().expect("openid poisoned") = Some(openid);
                *self.credentials.lock().expect("credentials poisoned") = None;
                if let Err(error) = self.persist().await {
                    return LoginResult {
                        success: false,
                        message: format!("openid 登录失败：{error}"),
                    };
                }
                let name = self.client.name();
                LoginResult {
                    success: true,
                    message: if name.is_empty() {
                        "认证成功".into()
                    } else {
                        format!("认证成功：{name}")
                    },
                }
            }
            Err(error) => {
                self.rollback(snapshot).await;
                LoginResult {
                    success: false,
                    message: format!("openid 登录失败：{error}"),
                }
            }
        }
    }

    async fn rollback(&self, snapshot: SessionSnapshot) {
        self.auth_jar
            .lock()
            .expect("auth jar poisoned")
            .replace_all(snapshot.cookies.clone());
        self.client.replace_cookies(snapshot.cookies);
        self.client.set_identity(snapshot.uid, snapshot.name);
        *self.credentials.lock().expect("credentials poisoned") = snapshot.credentials;
        *self.openid.lock().expect("openid poisoned") = snapshot.openid;
        let _ = self.persist().await;
    }

    pub async fn restore(&self) -> bool {
        if self.client.validate().await {
            return true;
        }
        self.refresh().await
    }

    pub fn install_refresh_callback(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let handler: RefreshHandler = Arc::new(move || {
            let weak = weak.clone();
            let future: Pin<Box<dyn Future<Output = bool> + Send>> = Box::pin(async move {
                match weak.upgrade() {
                    Some(auth) => auth.refresh().await,
                    None => false,
                }
            });
            future
        });
        self.client.set_refresh_handler(handler);
    }

    pub async fn refresh(&self) -> bool {
        if self.refreshing.swap(true, Ordering::SeqCst) {
            return false;
        }
        let result = self.refresh_inner().await;
        self.refreshing.store(false, Ordering::SeqCst);
        result
    }

    async fn refresh_inner(&self) -> bool {
        let credentials = self
            .credentials
            .lock()
            .expect("credentials poisoned")
            .clone();
        if let Some(credentials) = credentials {
            return self
                .login_password_inner(&credentials.student_id, &credentials.password)
                .await
                .map(|result| result.success)
                .unwrap_or(false);
        }
        let openid = self.openid.lock().expect("openid poisoned").clone();
        let Some(openid) = openid else {
            return false;
        };
        self.clear_state();
        match self.exchange_openid(&openid).await {
            Ok(()) => self.persist().await.is_ok(),
            Err(_) => false,
        }
    }

    pub async fn logout(&self) {
        self.clear_state();
        let _ = self.persist().await;
    }
}

impl AuthService {
    async fn ensure_sso_page(&self) -> Result<Url, AuthError> {
        let response = self
            .follow(
                &self.endpoints.sso_login_page,
                Method::GET,
                vec![(HEADER_USER_AGENT.to_string(), USER_AGENT.to_string())],
                None,
            )
            .await?;
        if !response.status().is_success() {
            return Err(AuthError::Invalid(format!(
                "SSO 页面不可用: {}",
                response.status()
            )));
        }
        let url = response.url().clone();
        let _ = response.text().await;
        let _ = self.load_csrf().await;
        Ok(url)
    }

    async fn load_csrf(&self) -> Result<(), AuthError> {
        let response = self
            .follow(
                &self.endpoints.sso_csrf_script,
                Method::GET,
                vec![(HEADER_USER_AGENT.to_string(), USER_AGENT.to_string())],
                None,
            )
            .await?;
        if !response.status().is_success() {
            return Ok(());
        }
        let script = response
            .text()
            .await
            .map_err(|error| AuthError::Invalid(error.to_string()))?;
        let key = first_capture(
            &script,
            &[
                r#"Csrf-Key['"]?\s*,\s*['"]([^'"]+)"#,
                r#"Csrf-Key['"]?\s*[:=]\s*['"]([^'"]+)"#,
            ],
        );
        let value = first_capture(
            &script,
            &[
                r#"Csrf-Value['"]?\s*,\s*['"]([^'"]+)"#,
                r#"Csrf-Value['"]?\s*[:=]\s*['"]([^'"]+)"#,
            ],
        );
        if let (Some(key), Some(value)) = (key, value) {
            *self.csrf.lock().expect("csrf poisoned") = Csrf { key, value };
        }
        Ok(())
    }

    fn sso_headers(&self, referer: &str) -> Vec<(String, String)> {
        let csrf = self.csrf.lock().expect("csrf poisoned").clone();
        vec![
            ("Accept".into(), "application/json, text/plain, */*".into()),
            (HEADER_USER_AGENT.to_string(), USER_AGENT.into()),
            ("Origin".into(), self.endpoints.sso.clone()),
            ("Referer".into(), referer.to_string()),
            ("Csrf-Key".into(), csrf.key),
            ("Csrf-Value".into(), csrf.value),
        ]
    }

    async fn read_sso_json(&self, response: Response) -> Result<Value, AuthError> {
        let body: Value = response
            .json()
            .await
            .map_err(|_| AuthError::Invalid("SSO 接口返回异常".into()))?;
        let code = body.get("code").and_then(Value::as_i64).or_else(|| {
            body.get("code")
                .and_then(Value::as_str)
                .and_then(|value| value.parse().ok())
        });
        if code != Some(200) {
            return Err(AuthError::Invalid(
                body.get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("SSO 接口返回异常")
                    .to_string(),
            ));
        }
        Ok(body)
    }

    pub async fn create_qr_login(self: &Arc<Self>) -> Result<QrLoginStart, AuthError> {
        let permit = self
            .qr_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| AuthError::Busy)?;
        let referer = self.ensure_sso_page().await?;
        let timestamp = Utc::now().timestamp_millis();
        let response = self
            .follow(
                &format!(
                    "{}/api/protected/qrlogin/loginid?{timestamp}",
                    self.endpoints.sso
                ),
                Method::GET,
                self.sso_headers(referer.as_str()),
                None,
            )
            .await?;
        if !response.status().is_success() {
            return Err(AuthError::Invalid(format!(
                "二维码 ID 请求失败: {}",
                response.status()
            )));
        }
        let body = self.read_sso_json(response).await?;
        let uuid = body
            .get("data")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AuthError::Invalid("二维码 ID 无效".into()))?
            .to_string();
        let image_response = self
            .follow(
                &format!(
                    "{}/api/public/qrlogin/qrgen/{}/dingDingQr?t={timestamp}",
                    self.endpoints.sso,
                    urlencoding::encode(&uuid)
                ),
                Method::GET,
                vec![
                    (
                        "Accept".into(),
                        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8".into(),
                    ),
                    (HEADER_USER_AGENT.to_string(), USER_AGENT.into()),
                    ("Referer".into(), referer.to_string()),
                ],
                None,
            )
            .await?;
        if !image_response.status().is_success() {
            return Err(AuthError::Invalid(format!(
                "二维码生成失败: {}",
                image_response.status()
            )));
        }
        let bytes = image_response
            .bytes()
            .await
            .map_err(|error| AuthError::Invalid(error.to_string()))?;
        if bytes.is_empty() {
            return Err(AuthError::Invalid("二维码内容为空".into()));
        }
        let image = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        );
        self.qr_sessions
            .lock()
            .expect("qr sessions poisoned")
            .insert(
                uuid.clone(),
                QrSession {
                    created_at: Utc::now().timestamp_millis(),
                    status: "waiting".into(),
                    message: None,
                    session: None,
                },
            );
        self.prune_qr_sessions();
        let service = self.clone();
        let scan_uuid = uuid.clone();
        tokio::spawn(async move {
            let _permit = permit;
            service.run_qr_scan_loop(scan_uuid).await;
        });
        Ok(QrLoginStart {
            uuid,
            image,
            ttl_seconds: 90,
        })
    }

    pub fn poll_qr_login(&self, uuid: &str) -> QrLoginStatus {
        let entry = {
            let sessions = self.qr_sessions.lock().expect("qr sessions poisoned");
            sessions.get(uuid).cloned()
        };
        match entry {
            Some(entry) => QrLoginStatus {
                status: entry.status,
                message: entry.message,
                session: entry.session,
            },
            None => QrLoginStatus {
                status: "error".into(),
                message: Some("二维码已失效，请刷新".into()),
                session: None,
            },
        }
    }

    fn prune_qr_sessions(&self) {
        let cutoff = Utc::now().timestamp_millis() - 10 * 60_000;
        let mut sessions = self.qr_sessions.lock().expect("qr sessions poisoned");
        sessions.retain(|_, entry| entry.created_at >= cutoff);
    }

    async fn poll_qr_round_for_token(&self, uuid: &str) -> Result<Option<String>, AuthError> {
        let referer = self.ensure_sso_page().await?;
        let timestamp = Utc::now().timestamp_millis();
        let result = tokio::time::timeout(
            Duration::from_secs(30),
            self.follow(
                &format!(
                    "{}/api/protected/qrlogin/scan/{}?{timestamp}",
                    self.endpoints.sso,
                    urlencoding::encode(uuid)
                ),
                Method::GET,
                self.sso_headers(referer.as_str()),
                None,
            ),
        )
        .await;
        let response = match result {
            Err(_) => return Ok(None),
            Ok(Err(error)) => return Err(error),
            Ok(Ok(response)) => response,
        };
        if !response.status().is_success() {
            return Err(AuthError::Invalid(format!(
                "扫码状态请求失败: {}",
                response.status()
            )));
        }
        let body = self.read_sso_json(response).await?;
        if let Some(token) = body
            .get("data")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            return Ok(Some(token.to_string()));
        }
        Err(AuthError::Invalid("二维码已过期，请刷新".into()))
    }

    async fn complete_qr_login(&self, token: &str) -> Result<(), AuthError> {
        if token.is_empty() {
            return Err(AuthError::Invalid("扫码授权令牌为空".into()));
        }
        let response = self
            .follow(
                &self.endpoints.sso_login_page,
                Method::POST,
                vec![
                    (HEADER_USER_AGENT.to_string(), USER_AGENT.into()),
                    ("Origin".into(), self.endpoints.sso.clone()),
                    ("Referer".into(), self.endpoints.sso_login_page.clone()),
                ],
                Some(vec![(token.to_string(), "login".into())]),
            )
            .await?;
        if response.url().as_str().starts_with(&self.endpoints.sso)
            && !response.url().as_str().contains("huitu.zhishulib.com")
        {
            return Err(AuthError::Invalid("扫码登录未完成，请重新扫码".into()));
        }
        self.sync_cookies_to_client();
        if !self.client.validate().await || self.client.uid().is_empty() {
            return Err(AuthError::Invalid("扫码登录后 Cookie 无效".into()));
        }
        self.persist().await?;
        Ok(())
    }

    async fn run_qr_scan_loop(&self, uuid: String) {
        let budget = Utc::now().timestamp_millis() + 90_000;
        while Utc::now().timestamp_millis() < budget {
            let entry = {
                let sessions = self.qr_sessions.lock().expect("qr sessions poisoned");
                sessions.get(&uuid).cloned()
            };
            let Some(entry) = entry else {
                return;
            };
            if entry.status != "waiting" {
                return;
            }
            match self.poll_qr_round_for_token(&uuid).await {
                Ok(Some(token)) => match self.complete_qr_login(&token).await {
                    Ok(()) => {
                        let session = self.status();
                        self.qr_sessions
                            .lock()
                            .expect("qr sessions poisoned")
                            .insert(
                                uuid,
                                QrSession {
                                    created_at: entry.created_at,
                                    status: "confirmed".into(),
                                    message: None,
                                    session: Some(session),
                                },
                            );
                        return;
                    }
                    Err(error) => {
                        self.qr_sessions
                            .lock()
                            .expect("qr sessions poisoned")
                            .insert(
                                uuid,
                                QrSession {
                                    created_at: entry.created_at,
                                    status: "error".into(),
                                    message: Some(error.to_string()),
                                    session: None,
                                },
                            );
                        return;
                    }
                },
                Ok(None) => continue,
                Err(error) => {
                    let message = error.to_string();
                    let expired = message.contains("expired") || message.contains("过期");
                    self.qr_sessions
                        .lock()
                        .expect("qr sessions poisoned")
                        .insert(
                            uuid,
                            QrSession {
                                created_at: entry.created_at,
                                status: if expired {
                                    "expired".into()
                                } else {
                                    "error".into()
                                },
                                message: Some(if expired {
                                    "二维码已过期，请刷新".into()
                                } else {
                                    message
                                }),
                                session: None,
                            },
                        );
                    return;
                }
            }
        }
        self.qr_sessions
            .lock()
            .expect("qr sessions poisoned")
            .insert(
                uuid,
                QrSession {
                    created_at: Utc::now().timestamp_millis(),
                    status: "expired".into(),
                    message: Some("二维码已过期，请刷新".into()),
                    session: None,
                },
            );
    }
}

fn first_capture(html: &str, patterns: &[&str]) -> Option<String> {
    for pattern in patterns {
        let regex = Regex::new(pattern).ok()?;
        if let Some(capture) = regex.captures(html) {
            if let Some(value) = capture
                .get(1)
                .map(|value| value.as_str().trim().to_string())
                .filter(|value| !value.is_empty())
            {
                return Some(value);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use hdu_sniper_store::SessionRow;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn endpoints(server: &MockServer) -> Endpoints {
        let library = server.uri();
        let sso = format!("{library}/sso");
        Endpoints {
            library: library.clone(),
            login_entry: format!("{library}/User/Index/hduCASLogin"),
            sso: sso.clone(),
            sso_login_page: format!("{sso}/login"),
            sso_csrf_script: format!("{sso}/csrf.js"),
        }
    }

    fn service(store: Arc<Store>, server: &MockServer) -> AuthService {
        AuthService::with_endpoints_and_secrets(store, endpoints(server), None).unwrap()
    }

    fn login_body() -> serde_json::Value {
        json!({"DATA": {"is_login": true, "uid": "304174", "user_info": {"name": "陈同学"}}})
    }

    #[tokio::test]
    async fn openid_login_persists_the_session() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/content/index/startUp/openid/abcdefghij_123/"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("set-cookie", "sid=openid; Path=/; HttpOnly"),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/User/Center/baseInfo"))
            .respond_with(ResponseTemplate::new(200).set_body_json(login_body()))
            .mount(&server)
            .await;
        let store = Arc::new(Store::open_in_memory().unwrap());
        let auth = service(store.clone(), &server);
        let result = auth
            .login_with_openid(
                "https://hdu.huitu.zhishulib.com/content/index/startUp/openid/abcdefghij_123/",
            )
            .await;
        assert!(result.success, "{result:?}");
        assert_eq!(auth.client.uid(), "304174");
        let saved = store.load_session().unwrap().unwrap();
        assert_eq!(saved.openid, "abcdefghij_123");
        assert!(saved.cookies.contains("sid"));
    }

    #[tokio::test]
    async fn password_login_follows_the_sso_form() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/User/Index/hduCASLogin"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"<input id="login-croypto" value="MDEyMzQ1Njc4OWFiY2RlZg==">
                <input id="login-page-flowkey" name="execution" value="exec-1">
                <form id="normalLoginForm" action="/login"></form>"#,
            ))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/login"))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", format!("{}/User/Center/baseInfo", server.uri())),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/User/Center/baseInfo"))
            .respond_with(ResponseTemplate::new(200).set_body_json(login_body()))
            .mount(&server)
            .await;
        let store = Arc::new(Store::open_in_memory().unwrap());
        let auth = service(store.clone(), &server);
        let result = auth.login_password("304174", "secret").await;
        assert!(result.success, "{result:?}");
        assert_eq!(auth.client.uid(), "304174");
        let saved = store.load_session().unwrap().unwrap();
        assert_eq!(saved.student_id, "304174");
        assert_eq!(saved.password, "secret");
    }

    #[tokio::test]
    async fn restore_validates_saved_cookies() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/User/Center/baseInfo"))
            .respond_with(ResponseTemplate::new(200).set_body_json(login_body()))
            .mount(&server)
            .await;
        let store = Arc::new(Store::open_in_memory().unwrap());
        let cookie = hdu_sniper_hdu::StoredCookie {
            name: "sid".into(),
            value: "saved".into(),
            domain: "127.0.0.1".into(),
            path: "/".into(),
            expires_at: None,
            secure: false,
            http_only: true,
        };
        store
            .save_session(&SessionRow {
                uid: "304174".into(),
                name: "陈同学".into(),
                cookies: serde_json::to_string(&vec![cookie]).unwrap(),
                updated_at: "2026-01-01T00:00:00.000Z".into(),
                ..SessionRow::default()
            })
            .unwrap();
        let auth = service(store, &server);
        assert!(auth.restore().await);
        assert_eq!(auth.client.uid(), "304174");
    }

    #[tokio::test]
    async fn confirms_a_qr_login_in_the_background() {
        use std::sync::Arc as TestArc;
        use std::time::Duration;
        use tokio::time::sleep;

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/sso/login"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>login</html>"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/sso/api/protected/qrlogin/loginid"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"code": 200, "data": "uuid-1"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/sso/api/public/qrlogin/qrgen/uuid-1/dingDingQr"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"png".to_vec()))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/sso/api/protected/qrlogin/scan/uuid-1"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"code": 200, "data": "token-1"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/sso/login"))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", format!("{}/User/Center/baseInfo", server.uri())),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/User/Center/baseInfo"))
            .respond_with(ResponseTemplate::new(200).set_body_json(login_body()))
            .mount(&server)
            .await;
        let store = Arc::new(Store::open_in_memory().unwrap());
        let auth = TestArc::new(service(store, &server));
        let start = auth.create_qr_login().await.unwrap();
        let mut status = auth.poll_qr_login(&start.uuid);
        for _ in 0..100 {
            if status.status == "confirmed" {
                break;
            }
            sleep(Duration::from_millis(10)).await;
            status = auth.poll_qr_login(&start.uuid);
        }
        assert_eq!(status.status, "confirmed");
        assert_eq!(status.session.unwrap().uid.as_deref(), Some("304174"));
    }

    #[tokio::test]
    async fn creates_a_qr_login() {
        use std::sync::Arc as TestArc;

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/sso/login"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>login</html>"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/sso/api/protected/qrlogin/loginid"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"code": 200, "data": "uuid-1"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/sso/api/public/qrlogin/qrgen/uuid-1/dingDingQr"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"png".to_vec()))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/sso/api/protected/qrlogin/scan/uuid-1"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"code": 200, "data": null})),
            )
            .mount(&server)
            .await;
        let store = Arc::new(Store::open_in_memory().unwrap());
        let auth = TestArc::new(service(store, &server));
        let start = auth.create_qr_login().await.unwrap();
        assert_eq!(start.uuid, "uuid-1");
        assert_eq!(start.ttl_seconds, 90);
        assert!(start.image.starts_with("data:image/png;base64,"));
        assert_eq!(auth.poll_qr_login("missing").status, "error");
    }

    #[tokio::test]
    async fn logout_clears_cookies_but_keeps_credentials() {
        let server = MockServer::start().await;
        let store = Arc::new(Store::open_in_memory().unwrap());
        store
            .save_session(&SessionRow {
                uid: "304174".into(),
                name: "陈同学".into(),
                student_id: "304174".into(),
                password: "secret".into(),
                cookies: "[]".into(),
                updated_at: "2026-01-01T00:00:00.000Z".into(),
                ..SessionRow::default()
            })
            .unwrap();
        let auth = service(store.clone(), &server);
        auth.logout().await;
        assert!(!auth.authenticated());
        let saved = store.load_session().unwrap().unwrap();
        assert_eq!(saved.student_id, "304174");
        assert_eq!(saved.password, "secret");
        assert_eq!(saved.cookies, "[]");
    }

    #[tokio::test]
    async fn migrates_plaintext_credentials_to_encrypted_blob() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store
            .save_session(&SessionRow {
                uid: "304174".into(),
                name: "陈同学".into(),
                student_id: "304174".into(),
                password: "secret".into(),
                openid: "oid".into(),
                cookies: "[]".into(),
                updated_at: "2026-01-01T00:00:00.000Z".into(),
                ..SessionRow::default()
            })
            .unwrap();
        let secrets = AesSecretStore::from_key(&[9u8; 32], "test").unwrap();
        let _auth = AuthService::with_endpoints_and_secrets(
            store.clone(),
            Endpoints::default(),
            Some(Box::new(secrets)),
        )
        .unwrap();
        let saved = store.load_session().unwrap().unwrap();
        assert_eq!(saved.password, "");
        assert_eq!(saved.openid, "");
        assert_eq!(saved.credentials_scheme, "test");
        let secrets = AesSecretStore::from_key(&[9u8; 32], "test").unwrap();
        let blob = secrets.open(&saved.credentials_enc).unwrap();
        let value: serde_json::Value = serde_json::from_str(&blob).unwrap();
        assert_eq!(value["password"], "secret");
        assert_eq!(value["student_id"], "304174");
        assert_eq!(value["openid"], "oid");
    }

    #[tokio::test]
    async fn blocks_password_login_after_repeated_failures() {
        let server = MockServer::start().await;
        let store = Arc::new(Store::open_in_memory().unwrap());
        let auth = service(store, &server);
        auth.note_login(false);
        auth.note_login(false);
        auth.note_login(false);
        assert!(auth.login_blocked().is_some());
        let result = auth.login_password("304174", "secret").await;
        assert!(!result.success);
        assert!(result.message.contains("尝试次数过多"));
    }
}
