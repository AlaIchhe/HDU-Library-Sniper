use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use chrono::{DateTime, Utc};
use md5::{Digest, Md5};
use percent_encoding::percent_decode_str;
use reqwest::header::{ACCEPT, CONTENT_TYPE, COOKIE, ORIGIN, REFERER, USER_AGENT};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use hdu_sniper_core::json::{value_to_i64, value_to_string};
use hdu_sniper_core::{READ_TIMEOUT_SECONDS, WRITE_TIMEOUT_SECONDS};

use crate::auth::LIBRARY_BASE;
use crate::cookies::CookieJar;

const MOBILE_USER_AGENT: &str =
    "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";

/// 写请求（bookSeats / lockSeats / 签到等）的单次超时。
/// 预锁提前量 60s > 30s，故 19:59:00 起单个成员最坏也在 19:59:30 结束，
/// 不会跨过 20:00 锚点（`booking_anchor_delay_seconds` 在 ≥20:00 时返回 +24h）。
const WRITE_TIMEOUT: Duration = Duration::from_secs(WRITE_TIMEOUT_SECONDS);

/// 读请求（座位图 / 预约列表 / 房间目录）的单次超时。
/// 实测 2026-11-13：读路径正常 205–510ms（docs/HUITU-LIMITS.md §1）。
/// 20:00 拥堵时一个卡住的连接会一直占满超时才放弃，期间无法重试——
/// 当晚两次 30s 超时吃掉 136s 窗口的 44%。读无速率限制，早放弃早重试才对。
const READ_TIMEOUT: Duration = Duration::from_secs(READ_TIMEOUT_SECONDS);

#[derive(Debug, thiserror::Error)]
pub enum HduError {
    #[error("{0}")]
    Library(String),
    #[error("{0}")]
    AuthenticationExpired(String),
    #[error("请求超时")]
    RequestTimeout,
    #[error("HTTP {0}")]
    Http(u16),
    #[error("网络错误: {0}")]
    Network(String),
    #[error("{0}")]
    Parse(String),
}

pub type HduLibraryError = HduError;
pub type RequestTimeoutError = HduError;
pub type AuthenticationExpiredError = HduError;
pub type RefreshHandler = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;
/// 刷新也失败时的收尾回调：会话确实死了，让上层清掉僵尸会话。
pub type AuthLostHandler = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoomType {
    pub name: String,
    pub query: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Cancel,
    CheckIn,
    ComeBack,
    Leave,
    SignOut,
}

#[derive(Clone)]
struct Category {
    category_id: String,
    content_id: String,
}

type JarChangeHandler = Arc<dyn Fn(&CookieJar) + Send + Sync>;

/// 馆方接口客户端：持有 Cookie、身份与分类缓存。
pub struct LibraryClient {
    base_url: String,
    http: Client,
    jar: Mutex<CookieJar>,
    uid: Mutex<String>,
    name: Mutex<String>,
    categories: Mutex<HashMap<String, Category>>,
    on_jar_change: Option<JarChangeHandler>,
    refresh_handler: Mutex<Option<RefreshHandler>>,
    auth_lost_handler: Mutex<Option<AuthLostHandler>>,
}

mod booking;
mod catalog;
mod parse;

pub use parse::BookingRange;

impl LibraryClient {
    pub fn new() -> Result<Self, HduError> {
        Self::with_base_url(LIBRARY_BASE)
    }

    pub fn with_base_url(base_url: &str) -> Result<Self, HduError> {
        let http = Client::builder()
            // 兜底超时。实际每个请求都会按读/写覆盖（见 request_json_once）：
            // 读 READ_TIMEOUT=5s，写 WRITE_TIMEOUT=30s。
            .timeout(WRITE_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .map_err(|error| HduError::Network(error.to_string()))?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            http,
            jar: Mutex::new(CookieJar::default()),
            uid: Mutex::new(String::new()),
            name: Mutex::new(String::new()),
            categories: Mutex::new(HashMap::new()),
            on_jar_change: None,
            refresh_handler: Mutex::new(None),
            auth_lost_handler: Mutex::new(None),
        })
    }

    pub fn set_on_jar_change<F>(&mut self, callback: F)
    where
        F: Fn(&CookieJar) + Send + Sync + 'static,
    {
        self.on_jar_change = Some(Arc::new(callback));
    }

    pub fn jar_snapshot(&self) -> CookieJar {
        self.jar.lock().expect("cookie jar poisoned").clone()
    }

    pub fn replace_cookies(&self, cookies: Vec<crate::cookies::StoredCookie>) {
        self.jar
            .lock()
            .expect("cookie jar poisoned")
            .replace_all(cookies);
    }

    pub fn clear_cookies(&self) {
        self.jar.lock().expect("cookie jar poisoned").clear();
    }

    pub fn uid(&self) -> String {
        self.uid.lock().expect("uid poisoned").clone()
    }

    pub fn name(&self) -> String {
        self.name.lock().expect("name poisoned").clone()
    }

    pub fn set_identity(&self, uid: String, name: String) {
        *self.uid.lock().expect("uid poisoned") = uid;
        *self.name.lock().expect("name poisoned") = name;
    }

    pub fn set_refresh_handler(&self, handler: RefreshHandler) {
        *self
            .refresh_handler
            .lock()
            .expect("refresh handler poisoned") = Some(handler);
    }

    pub fn set_auth_lost_handler(&self, handler: AuthLostHandler) {
        *self
            .auth_lost_handler
            .lock()
            .expect("auth lost handler poisoned") = Some(handler);
    }

    async fn notify_auth_lost(&self) {
        let handler = self
            .auth_lost_handler
            .lock()
            .expect("auth lost handler poisoned")
            .clone();
        if let Some(handler) = handler {
            handler().await;
        }
    }

    async fn request_json(
        &self,
        path: &str,
        method: Method,
        form: Option<Vec<(String, String)>>,
        extra_headers: Vec<(String, String)>,
        timeout: Duration,
    ) -> Result<Value, HduError> {
        let result = self
            .request_json_once(
                path,
                method.clone(),
                form.clone(),
                extra_headers.clone(),
                timeout,
            )
            .await;
        if !matches!(&result, Err(HduError::AuthenticationExpired(_))) {
            return result;
        }
        let handler = self
            .refresh_handler
            .lock()
            .expect("refresh handler poisoned")
            .clone();
        if let Some(handler) = handler {
            if handler().await {
                let retried = self
                    .request_json_once(path, method, form, extra_headers, timeout)
                    .await;
                if matches!(&retried, Err(HduError::AuthenticationExpired(_))) {
                    self.notify_auth_lost().await;
                }
                return retried;
            }
        }
        // 刷新失败：会话确实死了。通知上层清掉僵尸会话（凭据保留供下次使用），
        // 否则 /api/session 会继续报 authenticated，前端在登录页和主页面之间弹跳。
        self.notify_auth_lost().await;
        result
    }

    async fn request_json_once(
        &self,
        path: &str,
        method: Method,
        form: Option<Vec<(String, String)>>,
        extra_headers: Vec<(String, String)>,
        timeout: Duration,
    ) -> Result<Value, HduError> {
        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}{}", self.base_url, path)
        };
        let cookie = self
            .jar
            .lock()
            .expect("cookie jar poisoned")
            .header_for(&url);
        let mut request = self
            .http
            .request(method, &url)
            .timeout(timeout)
            .header(ACCEPT, "application/json, text/plain, */*")
            .header(
                CONTENT_TYPE,
                "application/x-www-form-urlencoded;charset=UTF-8",
            )
            .header(ORIGIN, &self.base_url)
            .header(REFERER, format!("{}/", self.base_url))
            .header(USER_AGENT, MOBILE_USER_AGENT);
        for (key, value) in extra_headers {
            request = request.header(key, value);
        }
        if !cookie.is_empty() {
            request = request.header(COOKIE, cookie);
        }
        if let Some(form) = form {
            request = request.form(&form);
        }
        let response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                HduError::RequestTimeout
            } else {
                HduError::Network(error.to_string())
            }
        })?;
        let headers = response.headers().clone();
        let changed = self
            .jar
            .lock()
            .expect("cookie jar poisoned")
            .merge_headers(&headers, &url);
        if changed {
            if let Some(callback) = &self.on_jar_change {
                callback(&self.jar_snapshot());
            }
        }
        if !response.status().is_success() {
            return Err(HduError::Http(response.status().as_u16()));
        }
        let body: Value = response
            .json()
            .await
            .map_err(|_| HduError::Parse("慧图响应格式无效".into()))?;
        if body.get("ui_type").and_then(Value::as_str) == Some("com.Redirect")
            && body
                .get("href")
                .and_then(Value::as_str)
                .is_some_and(|href| href.contains("/User/Index/hduCASLogin"))
        {
            return Err(HduError::AuthenticationExpired(
                "图书馆登录状态已失效".into(),
            ));
        }
        Ok(body)
    }

    pub async fn validate(&self) -> bool {
        let Ok(body) = self
            .request_json(
                "/User/Center/baseInfo",
                Method::GET,
                None,
                Vec::new(),
                READ_TIMEOUT,
            )
            .await
        else {
            return false;
        };
        self.apply_base_info(&body)
    }

    /// 不做自动刷新重试的登录态检查。
    ///
    /// 登录流程写完 cookie 后自检时用：此时手动登录已经持有登录锁，
    /// 若这里再走 [`Self::request_json`] 的 refresh 重试就会撞上锁，
    /// 登录反而被判成“Cookie 无效”。
    pub async fn validate_once(&self) -> bool {
        let Ok(body) = self
            .request_json_once(
                "/User/Center/baseInfo",
                Method::GET,
                None,
                Vec::new(),
                READ_TIMEOUT,
            )
            .await
        else {
            return false;
        };
        self.apply_base_info(&body)
    }

    fn apply_base_info(&self, body: &Value) -> bool {
        let Some(data) = body.get("DATA") else {
            return false;
        };
        let logged_in = data
            .get("is_login")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let uid = data.get("uid").map(value_to_string).unwrap_or_default();
        if !logged_in || !uid.chars().all(|ch| ch.is_ascii_digit()) || uid.is_empty() {
            return false;
        }
        let name = data
            .get("user_info")
            .and_then(|info| info.get("name"))
            .map(value_to_string)
            .unwrap_or_default();
        self.set_identity(uid, name);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn client() -> (MockServer, LibraryClient) {
        let server = MockServer::start().await;
        let client = LibraryClient::with_base_url(&server.uri()).unwrap();
        (server, client)
    }

    #[tokio::test]
    async fn notifies_when_refresh_also_expires() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/User/Center/baseInfo"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "ui_type": "com.Redirect",
                "href": "/User/Index/hduCASLogin"
            })))
            .mount(&server)
            .await;
        let client = LibraryClient::with_base_url(&server.uri()).unwrap();
        client.set_refresh_handler(Arc::new(
            || -> Pin<Box<dyn Future<Output = bool> + Send>> { Box::pin(async { false }) },
        ));
        let lost = Arc::new(AtomicUsize::new(0));
        let counter = lost.clone();
        client.set_auth_lost_handler(Arc::new(move || {
            let counter = counter.clone();
            let future: Pin<Box<dyn Future<Output = ()> + Send>> = Box::pin(async move {
                counter.fetch_add(1, Ordering::SeqCst);
            });
            future
        }));
        assert!(!client.validate().await);
        assert_eq!(lost.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn validates_identity_and_updates_cookies() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/User/Center/baseInfo"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("set-cookie", "sid=abc; Path=/; HttpOnly")
                    .set_body_json(json!({"DATA": {"is_login": true, "uid": "304174", "user_info": {"name": "陈同学"}}})),
            )
            .mount(&server)
            .await;
        let client = LibraryClient::with_base_url(&server.uri()).unwrap();
        assert!(client.validate().await);
        assert_eq!(client.uid(), "304174");
        assert_eq!(client.name(), "陈同学");
        assert!(client
            .jar_snapshot()
            .header_for(&format!("{}/User/Center/baseInfo", server.uri()))
            .contains("sid=abc"));
    }

    #[tokio::test]
    async fn reports_authentication_expiry() {
        let (server, client) = client().await;
        Mock::given(method("GET"))
            .and(path("/Seat/Index/myBookingList"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "ui_type": "com.Redirect",
                "href": "https://hdu.huitu.zhishulib.com/User/Index/hduCASLogin"
            })))
            .mount(&server)
            .await;
        let error = client.bookings().await.unwrap_err();
        assert!(matches!(error, HduError::AuthenticationExpired(_)));
    }

    #[tokio::test]
    async fn retries_once_after_refreshing_the_session() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/Seat/Index/myBookingList"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "ui_type": "com.Redirect",
                "href": "https://hdu.huitu.zhishulib.com/User/Index/hduCASLogin"
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/Seat/Index/myBookingList"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"content": {"defaultItems": [{"id": "b1"}]}})),
            )
            .mount(&server)
            .await;
        let client = LibraryClient::with_base_url(&server.uri()).unwrap();
        let refreshes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = refreshes.clone();
        client.set_refresh_handler(Arc::new(move || {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async { true })
        }));
        let bookings = client.bookings().await.unwrap();
        assert_eq!(bookings.len(), 1);
        assert_eq!(refreshes.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn parses_nested_room_types() {
        let (server, client) = client().await;
        Mock::given(method("GET"))
            .and(path("/Space/Category/list"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "content": {"children": [
                    {"name": "空", "defaultItems": []},
                    {"children": [{"defaultItems": [{
                        "name": "自习室",
                        "link": {"url": "/Seat/Index/searchSeats?space_category[category_id]=3&space_category[content_id]=93"}
                    }]}]}
                ]}
            })))
            .mount(&server)
            .await;
        let types = client.room_types().await.unwrap();
        assert_eq!(
            types,
            vec![RoomType {
                name: "自习室".into(),
                query: "space_category[category_id]=3&space_category[content_id]=93".into(),
            }]
        );
    }

    #[tokio::test]
    async fn sends_booking_token_and_seat_booker() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/Seat/Index/bookSeats"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"CODE": "ok", "DATA": {"result": "success"}})),
            )
            .mount(&server)
            .await;
        let client = LibraryClient::with_base_url(&server.uri()).unwrap();
        client.set_identity("304174".into(), String::new());
        assert!(client.book_seat("42", Utc::now(), 1).await.is_ok());
        let requests = server.received_requests().await.unwrap();
        let request = requests.last().unwrap();
        assert!(request.headers.get("Api-Token").is_some());
        let body = String::from_utf8_lossy(&request.body);
        assert!(body.contains("seats%5B0%5D=42") || body.contains("seats[0]=42"));
        assert!(
            body.contains("seatBookers%5B0%5D=304174") || body.contains("seatBookers[0]=304174")
        );
    }
}

#[cfg(test)]
mod more_tests {
    use super::parse::api_token;
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn client(server: &MockServer) -> LibraryClient {
        LibraryClient::with_base_url(&server.uri()).unwrap()
    }

    #[test]
    fn api_token_matches_the_bun_contract() {
        assert_eq!(
            api_token("42", "304174", 1789779600, 43200, 1789779000),
            "OTA3MTA5Y2M1MGU2MzYwNzI2NGFjNzEyMmQ1ZjE5YTc="
        );
    }

    #[tokio::test]
    async fn parses_booking_range() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/Seat/Index/searchSeats"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {"range": {"minBeginTime": 7, "maxEndTime": 22, "min_duration": 1, "max_duration": 15}}
            })))
            .mount(&server)
            .await;
        let range = client(&server)
            .await
            .booking_range("space_category[category_id]=591&space_category[content_id]=3")
            .await
            .unwrap();
        assert_eq!(range.min_begin_time, 7);
        assert_eq!(range.max_end_time, 22);
        assert_eq!(range.min_duration, 1);
        assert_eq!(range.max_duration, 15);
    }

    #[tokio::test]
    async fn parses_the_floor_container() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/Seat/Index/searchSeats"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {"space_category": {"category_id": "1", "content_id": "91"}}
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/Seat/Index/searchSeats"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "allContent": {
                    "children": [
                        {"children": {}},
                        {"children": {}},
                        {"children": {"children": [
                            {"roomName": "四楼", "seatMap": {"info": {"id": "1558"}, "POIs": [{"title": "298"}]}}
                        ]}}
                    ]
                }
            })))
            .mount(&server)
            .await;
        let floors = client(&server)
            .await
            .floors(
                "space_category[category_id]=1&space_category[content_id]=91",
                Utc::now(),
                1,
            )
            .await
            .unwrap();
        assert_eq!(floors.len(), 1);
        assert_eq!(floors[0]["roomName"], "四楼");
    }

    #[tokio::test]
    async fn uses_the_huitu_action_endpoints() {
        for (action, endpoint) in [
            (Action::Cancel, "/Seat/Index/cancelBooking"),
            (Action::CheckIn, "/Seat/Index/checkIn"),
            (Action::ComeBack, "/Seat/Index/comeBack"),
            (Action::SignOut, "/Seat/Index/checkOut"),
        ] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path(endpoint))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "CODE": "ok", "DATA": {"result": "success"}
                })))
                .mount(&server)
                .await;
            client(&server)
                .await
                .action(action, "123")
                .await
                .unwrap_or_else(|error| panic!("{endpoint}: {error}"));
        }
    }

    #[tokio::test]
    async fn leave_looks_up_the_latest_time_then_steps_out() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/Seat/Index/stepOutLatestComeBackTime"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "CODE": "ok", "DATA": {"result": "success", "latest_come_back_time": 1800}
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/Seat/Index/stepOut"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "CODE": "ok", "DATA": {"result": "success"}
            })))
            .mount(&server)
            .await;
        client(&server)
            .await
            .action(Action::Leave, "123")
            .await
            .unwrap();
        let requests = server.received_requests().await.unwrap();
        assert!(requests
            .iter()
            .any(|request| request.url.path() == "/Seat/Index/stepOutLatestComeBackTime"));
        assert!(requests
            .iter()
            .any(|request| request.url.path() == "/Seat/Index/stepOut"));
    }

    #[tokio::test]
    async fn business_failure_prefers_data_msg() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/Seat/Index/checkIn"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "CODE": "ok", "MESSAGE": "顶层信息", "DATA": {"result": "fail", "msg": "预约单不存在"}
            })))
            .mount(&server)
            .await;
        let error = client(&server)
            .await
            .action(Action::CheckIn, "123")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("预约单不存在"));
    }

    /// 实测 2026-11-13：读路径并发保护返回 HTTP 404 + `{"CODE":"NotFound"}`。
    /// 状态判定先于 JSON 解析，故必须落成 Http(404) 变体，
    /// 上层据此立即重试（该状态瞬时恢复，不累积）。
    #[tokio::test]
    async fn seat_map_concurrency_guard_maps_to_http_404() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/Seat/Index/searchSeats"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {"space_category": {"category_id": "1", "content_id": "91"}}
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/Seat/Index/searchSeats"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({
                "CODE": "NotFound", "ui_type": "com.Message"
            })))
            .mount(&server)
            .await;
        let error = client(&server)
            .await
            .floors(
                "space_category[category_id]=1&space_category[content_id]=91",
                Utc::now(),
                1,
            )
            .await
            .unwrap_err();
        assert!(matches!(error, HduError::Http(404)), "实际：{error:?}");
        assert_eq!(error.to_string(), "HTTP 404");
    }

    /// 实测 2026-11-13：cancelBooking 成功时 CODE=ok、MESSAGE=取消预约成功，
    /// DATA 只含用户信息、**没有 result 字段**。旧实现强求 result=success 会误判为失败。
    #[tokio::test]
    async fn cancel_succeeds_without_a_result_field() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/Seat/Index/cancelBooking"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "CODE": "ok",
                "MESSAGE": "取消预约成功",
                "DATA": {"href": "", "is_login": true, "lab_content_org_id": "104"}
            })))
            .mount(&server)
            .await;
        client(&server)
            .await
            .action(Action::Cancel, "123")
            .await
            .expect("CODE=ok 且无 result 字段应视为成功");
    }

    /// result 字段存在时仍须为 success，放宽不得掩盖真实失败。
    #[tokio::test]
    async fn explicit_result_fail_still_fails() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/Seat/Index/cancelBooking"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "CODE": "ok", "DATA": {"result": "fail", "msg": "预约单不存在"}
            })))
            .mount(&server)
            .await;
        let error = client(&server)
            .await
            .action(Action::Cancel, "123")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("预约单不存在"));
    }

    /// 限流响应 CODE=1，不得因 result 缺失而被当成成功。
    #[tokio::test]
    async fn rate_limit_is_not_treated_as_success() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/Seat/Index/checkIn"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "CODE": "1", "MESSAGE": "请求过于频繁，请10分钟后再试"
            })))
            .mount(&server)
            .await;
        let error = client(&server)
            .await
            .action(Action::CheckIn, "123")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("请求过于频繁"));
    }

    /// 读请求必须在 READ_TIMEOUT 内放弃，不能沿用写请求的 30s。
    /// 实测 2026-11-13：20:00 两次 30s 读超时吃掉 136s 窗口的 44%，
    /// 期间无法重试。读路径正常 205–510ms，卡住就该早点放弃。
    #[tokio::test]
    async fn read_requests_give_up_at_the_read_timeout() {
        let server = MockServer::start().await;
        // 延迟远超 READ_TIMEOUT(5s)、但小于 WRITE_TIMEOUT(30s)：
        // 若读仍用 30s，这个请求会成功而不是超时。
        Mock::given(method("GET"))
            .and(path("/Seat/Index/myBookingList"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_secs(8))
                    .set_body_json(json!({"content": {"defaultItems": []}})),
            )
            .mount(&server)
            .await;
        let started = std::time::Instant::now();
        let error = client(&server).await.bookings().await.unwrap_err();
        let elapsed = started.elapsed();
        assert!(matches!(error, HduError::RequestTimeout), "实际：{error:?}");
        assert!(
            elapsed < Duration::from_secs(7),
            "读请求应在 5s 超时，实际等了 {elapsed:?}"
        );
    }

    /// 写请求仍保留 30s：预锁提前量 60s 的上界依赖它，且写入不能轻易放弃
    /// （放弃后无从判断馆方是否已落单）。
    #[tokio::test]
    async fn write_requests_keep_the_longer_timeout() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/Seat/Index/lockSeats"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_secs(7))
                    .set_body_json(json!({"CODE": "ok", "DATA": {"result": "fail"}})),
            )
            .mount(&server)
            .await;
        // 7s > READ_TIMEOUT，若写请求误用读超时就会失败
        let response = client(&server)
            .await
            .lock_seat("42", Utc::now(), 1)
            .await
            .expect("写请求不应在 5s 被放弃");
        assert_eq!(response.get("CODE").and_then(Value::as_str), Some("ok"));
    }
}
