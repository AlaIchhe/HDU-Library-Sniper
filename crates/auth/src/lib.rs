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
    encrypt_password, extract_openid, AuthLostHandler, CookieJar, HduError, LibraryClient,
    RefreshHandler, StoredCookie, LIBRARY_BASE, LOGIN_ENTRY, OPENID_USER_AGENT, SSO_BASE,
    SSO_CSRF_KEY, SSO_CSRF_VALUE, USER_AGENT,
};
use hdu_sniper_store::{SessionRow, Store, StoreError};
use regex::Regex;
use reqwest::header::{ACCEPT, COOKIE, LOCATION, USER_AGENT as HEADER_USER_AGENT};
use reqwest::{Client, Method, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Semaphore;
use url::Url;

mod qr;
mod secrets;
mod session;
mod sso;
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
    /// 前端最后一次轮询的时间；没有人看二维码时扫描循环应主动停下。
    last_polled_at: i64,
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
    /// 串行化所有会写回会话的 SSO 登录（手动密码登录 vs 后台刷新/扫码完成）。
    login_gate: tokio::sync::Mutex<()>,
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
            login_gate: tokio::sync::Mutex::new(()),
        };
        if legacy_plaintext && service.secrets.is_some() {
            if let Err(error) = service.persist_now() {
                tracing::warn!(%error, "迁移明文凭据失败");
            }
        }
        Ok(service)
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
}

impl AuthService {}

#[cfg(test)]
mod tests {
    use super::*;
    use hdu_sniper_store::SessionRow;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

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
    async fn clears_the_zombie_session_when_refresh_fails() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/User/Center/baseInfo"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "ui_type": "com.Redirect",
                "href": "/User/Index/hduCASLogin"
            })))
            .mount(&server)
            .await;
        let store = Arc::new(Store::open_in_memory().unwrap());
        store
            .save_session(&SessionRow {
                uid: "304174".into(),
                name: "陈同学".into(),
                cookies: "[]".into(),
                updated_at: "2026-01-01T00:00:00.000Z".into(),
                ..SessionRow::default()
            })
            .unwrap();
        let auth = Arc::new(service(store.clone(), &server));
        auth.install_refresh_callback();
        assert!(auth.authenticated());
        // 馆方返回“登录态失效”，但没有可用凭据可刷新：会话应被清掉，
        // 否则 /api/session 仍报 authenticated，前端会在登录页和主页面之间弹跳。
        assert!(!auth.client.validate().await);
        assert!(!auth.authenticated(), "the dead session must be cleared");
        assert!(store.load_session().unwrap().unwrap().uid.is_empty());
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

    fn login_page_html(execution: &str) -> String {
        format!(
            r#"<p id="login-croypto">MDEyMzQ1Njc4OWFiY2RlZg==</p>
            <p id="login-page-flowkey">{execution}</p>
            <form id="normalLoginForm" action="/login"></form>"#
        )
    }

    #[tokio::test]
    async fn password_login_ignores_the_shared_cookie_jar() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/User/Index/hduCASLogin"))
            .respond_with(ResponseTemplate::new(200).set_body_string(login_page_html("exec-1")))
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
        let auth = service(store, &server);
        // 共享 jar 里的旧会话。旧实现会把它带进登录请求，和 SSO 当次下发的
        // SESSION 混在一起；隔离后登录只能看到自己这一次的 cookie。
        auth.auth_jar
            .lock()
            .expect("auth jar poisoned")
            .replace_all(vec![StoredCookie {
                name: "stale".into(),
                value: "1".into(),
                domain: "127.0.0.1".into(),
                path: "/".into(),
                expires_at: None,
                secure: false,
                http_only: false,
            }]);
        let result = auth.login_password("304174", "secret").await;
        assert!(result.success, "{result:?}");
        let requests = server.received_requests().await.unwrap();
        let page = requests
            .iter()
            .find(|request| request.url.path() == "/User/Index/hduCASLogin")
            .expect("the login page GET should be recorded");
        let cookie = page
            .headers
            .get("cookie")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        assert!(
            !cookie.contains("stale=1"),
            "password login leaked the shared jar: {cookie}"
        );
    }

    struct TwoStepResponder {
        calls: Arc<std::sync::atomic::AtomicUsize>,
        base: String,
    }

    impl Respond for TwoStepResponder {
        fn respond(&self, _request: &Request) -> ResponseTemplate {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let location = if call == 0 {
                // 第一次：SSO 把 POST 又转回自己的登录页（会话/网关抖动）。
                format!("{}/sso/login?service=test", self.base)
            } else {
                format!("{}/User/Center/baseInfo", self.base)
            };
            ResponseTemplate::new(302).insert_header("location", location)
        }
    }

    async fn retry_fixture(
        sso_page: &'static str,
    ) -> (
        MockServer,
        Arc<AuthService>,
        Arc<std::sync::atomic::AtomicUsize>,
    ) {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/User/Index/hduCASLogin"))
            .respond_with(ResponseTemplate::new(200).set_body_string(login_page_html("exec-1")))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/sso/login"))
            .respond_with(ResponseTemplate::new(200).set_body_string(sso_page))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/User/Center/baseInfo"))
            .respond_with(ResponseTemplate::new(200).set_body_json(login_body()))
            .mount(&server)
            .await;
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        Mock::given(method("POST"))
            .and(path("/login"))
            .respond_with(TwoStepResponder {
                calls: calls.clone(),
                base: server.uri(),
            })
            .mount(&server)
            .await;
        let store = Arc::new(Store::open_in_memory().unwrap());
        let auth = Arc::new(service(store, &server));
        (server, auth, calls)
    }

    #[tokio::test]
    async fn sso_session_blip_is_retried_once() {
        // 没有 login-error-msg：属于会话/网关抖动，值得换一份会话再来一次。
        let (_server, auth, calls) = retry_fixture("<html>sso hiccup</html>").await;
        let result = auth.login_password("304174", "secret").await;
        assert!(result.success, "{result:?}");
        assert_eq!(calls.load(Ordering::SeqCst), 2, "expected one retry");
    }

    #[tokio::test]
    async fn sso_credential_error_is_not_retried() {
        // 真实 SSO 的失败页带 login-error-msg：凭据错误，不重试。
        let (_server, auth, calls) = retry_fixture(
            r#"<div class="alert alert-danger" id="login-error-msg"><span>用户名或密码错误</span></div>"#,
        )
        .await;
        let result = auth.login_password("304174", "wrong").await;
        assert!(!result.success);
        assert!(result.message.contains("SSO 登录失败"));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "credential errors must not retry"
        );
    }

    #[tokio::test]
    async fn cancel_qr_login_removes_the_session() {
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
        let auth = Arc::new(service(store, &server));
        let start = auth.create_qr_login().await.unwrap();
        assert!(auth.cancel_qr_login(&start.uuid));
        assert_eq!(auth.poll_qr_login(&start.uuid).status, "error");
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
