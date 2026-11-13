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

use crate::auth::LIBRARY_BASE;
use crate::cookies::CookieJar;

const MOBILE_USER_AGENT: &str =
    "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";

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
            .timeout(Duration::from_secs(30))
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

    async fn request_json(
        &self,
        path: &str,
        method: Method,
        form: Option<Vec<(String, String)>>,
        extra_headers: Vec<(String, String)>,
    ) -> Result<Value, HduError> {
        let result = self
            .request_json_once(path, method.clone(), form.clone(), extra_headers.clone())
            .await;
        if matches!(&result, Err(HduError::AuthenticationExpired(_))) {
            let handler = self
                .refresh_handler
                .lock()
                .expect("refresh handler poisoned")
                .clone();
            if let Some(handler) = handler {
                if handler().await {
                    return self
                        .request_json_once(path, method, form, extra_headers)
                        .await;
                }
            }
        }
        result
    }

    async fn request_json_once(
        &self,
        path: &str,
        method: Method,
        form: Option<Vec<(String, String)>>,
        extra_headers: Vec<(String, String)>,
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
            .request_json("/User/Center/baseInfo", Method::GET, None, Vec::new())
            .await
        else {
            return false;
        };
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
}
