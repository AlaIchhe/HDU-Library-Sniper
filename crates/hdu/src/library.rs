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

pub struct LibraryClient {
    base_url: String,
    http: Client,
    jar: Mutex<CookieJar>,
    uid: Mutex<String>,
    name: Mutex<String>,
    categories: Mutex<HashMap<String, Category>>,
    on_jar_change: Option<Arc<dyn Fn(&CookieJar) + Send + Sync>>,
    refresh_handler: Mutex<Option<RefreshHandler>>,
}

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

    pub async fn room_types(&self) -> Result<Vec<RoomType>, HduError> {
        let body = self
            .request_json(
                "/Space/Category/list?LAB_JSON=1",
                Method::GET,
                None,
                Vec::new(),
            )
            .await?;
        let items = [body.get("content"), body.get("data"), body.get("DATA")]
            .into_iter()
            .flatten()
            .find_map(find_non_empty_default_items)
            .ok_or_else(|| HduError::Library("房间类型解析失败".into()))?;
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            let name = item.get("name").map(value_to_string).unwrap_or_default();
            let url = item
                .get("link")
                .map(|link| {
                    if let Some(text) = link.as_str() {
                        text.to_string()
                    } else {
                        link.get("url").map(value_to_string).unwrap_or_default()
                    }
                })
                .unwrap_or_default();
            let query = url
                .split_once('?')
                .map(|(_, query)| query)
                .ok_or_else(|| HduError::Library("房间类型链接解析失败".into()))?;
            let query = percent_decode_str(query)
                .decode_utf8()
                .map_err(|_| HduError::Library("房间类型链接解析失败".into()))?
                .to_string();
            out.push(RoomType { name, query });
        }
        Ok(out)
    }

    pub async fn booking_range(&self, room_query: &str) -> Result<BookingRange, HduError> {
        let body = self
            .request_json(
                &format!("/Seat/Index/searchSeats?{room_query}&LAB_JSON=1"),
                Method::GET,
                None,
                Vec::new(),
            )
            .await?;
        let range = body
            .get("data")
            .and_then(|data| data.get("range"))
            .ok_or_else(|| HduError::Library("预约时间范围解析失败".into()))?;
        Ok(BookingRange {
            min_begin_time: range.get("minBeginTime").map(value_to_i64).unwrap_or(0),
            max_end_time: range.get("maxEndTime").map(value_to_i64).unwrap_or(0),
            min_duration: range.get("min_duration").map(value_to_i64).unwrap_or(1),
            max_duration: range.get("max_duration").map(value_to_i64).unwrap_or(0),
        })
    }

    pub async fn floors(
        &self,
        room_query: &str,
        lookup_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Vec<Value>, HduError> {
        let category = self.lookup_category(room_query).await?;
        let form = vec![
            ("beginTime".into(), (lookup_time.timestamp()).to_string()),
            ("duration".into(), (duration_hours * 3600).to_string()),
            ("num".into(), "1".into()),
            ("space_category[category_id]".into(), category.category_id),
            ("space_category[content_id]".into(), category.content_id),
        ];
        let body = self
            .request_json(
                "/Seat/Index/searchSeats?LAB_JSON=1",
                Method::POST,
                Some(form),
                Vec::new(),
            )
            .await?;
        let floors = body
            .get("allContent")
            .and_then(|all| all.get("children"))
            .and_then(|children| children.get(2))
            .and_then(|container| container.get("children"))
            .and_then(|container| container.get("children"))
            .and_then(Value::as_array)
            .ok_or_else(|| HduError::Library("座位图解析失败".into()))?;
        Ok(floors.clone())
    }

    async fn lookup_category(&self, room_query: &str) -> Result<Category, HduError> {
        if let Some(category) = self
            .categories
            .lock()
            .expect("category cache poisoned")
            .get(room_query)
            .cloned()
        {
            return Ok(category);
        }
        let body = self
            .request_json(
                &format!("/Seat/Index/searchSeats?{room_query}&LAB_JSON=1"),
                Method::GET,
                None,
                Vec::new(),
            )
            .await?;
        let category = body
            .get("data")
            .and_then(|data| data.get("space_category"))
            .ok_or_else(|| HduError::Library("房间详情解析失败".into()))?;
        let category_id = category
            .get("category_id")
            .map(value_to_string)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| HduError::Library("房间详情解析失败".into()))?;
        let category = Category {
            category_id,
            content_id: category
                .get("content_id")
                .map(value_to_string)
                .unwrap_or_default(),
        };
        self.categories
            .lock()
            .expect("category cache poisoned")
            .insert(room_query.to_string(), category.clone());
        Ok(category)
    }

    pub async fn bookings(&self) -> Result<Vec<Value>, HduError> {
        let body = self
            .request_json(
                "/Seat/Index/myBookingList?fromType=web&LAB_JSON=1",
                Method::GET,
                None,
                Vec::new(),
            )
            .await?;
        body.get("content")
            .and_then(|content| content.get("defaultItems"))
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| HduError::Library("预约列表解析失败".into()))
    }

    pub async fn book_seat(
        &self,
        seat_id: &str,
        begin_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Value, HduError> {
        let uid = self.uid();
        if uid.is_empty() {
            return Err(HduError::AuthenticationExpired("缺少用户 UID".into()));
        }
        let begin = begin_time.timestamp();
        let duration = duration_hours * 3600;
        let api_time = Utc::now().timestamp();
        let form = vec![
            ("beginTime".into(), begin.to_string()),
            ("duration".into(), duration.to_string()),
            ("is_recommend".into(), "0".into()),
            ("api_time".into(), api_time.to_string()),
            ("seats[0]".into(), seat_id.to_string()),
            ("seatBookers[0]".into(), uid.clone()),
        ];
        let token = api_token(seat_id, &uid, begin, duration, api_time);
        self.request_json(
            "/Seat/Index/bookSeats?LAB_JSON=1",
            Method::POST,
            Some(form),
            vec![("Api-Token".into(), token)],
        )
        .await
    }

    pub async fn lock_seat(
        &self,
        seat_id: &str,
        begin_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Value, HduError> {
        let begin = begin_time.timestamp();
        let duration = duration_hours * 3600;
        let form = vec![
            ("beginTime".into(), begin.to_string()),
            ("duration".into(), duration.to_string()),
            ("is_recommend".into(), "0".into()),
            ("api_time".into(), Utc::now().timestamp().to_string()),
            ("seats[0]".into(), seat_id.to_string()),
        ];
        self.request_json(
            "/Seat/Index/lockSeats?LAB_JSON=1",
            Method::POST,
            Some(form),
            Vec::new(),
        )
        .await
    }

    pub async fn unlock_all_seats(&self) -> Result<Value, HduError> {
        self.request_json(
            "/Seat/Index/unlockAllSeats?LAB_JSON=1",
            Method::POST,
            None,
            Vec::new(),
        )
        .await
    }

    pub async fn action(&self, action: Action, booking_id: &str) -> Result<Value, HduError> {
        let encoded_id = urlencoding::encode(booking_id);
        if action == Action::Leave {
            let latest = self
                .request_json(
                    &format!(
                        "/Seat/Index/stepOutLatestComeBackTime?bookingId={encoded_id}&LAB_JSON=1"
                    ),
                    Method::POST,
                    None,
                    Vec::new(),
                )
                .await?;
            assert_action_success(&latest)?;
            let come_back_time = latest
                .get("DATA")
                .and_then(|data| data.get("latest_come_back_time"))
                .map(value_to_i64)
                .unwrap_or(0);
            if come_back_time <= 0 {
                return Err(HduError::Library("无法获取暂离返回时间".into()));
            }
            let body = self
                .request_json(
                    &format!("/Seat/Index/stepOut?bookingId={encoded_id}&LAB_JSON=1"),
                    Method::POST,
                    Some(vec![("comeBackTime".into(), come_back_time.to_string())]),
                    Vec::new(),
                )
                .await?;
            assert_action_success(&body)?;
            return Ok(body);
        }
        let endpoint = match action {
            Action::Cancel => "/Seat/Index/cancelBooking",
            Action::CheckIn => "/Seat/Index/checkIn",
            Action::ComeBack => "/Seat/Index/comeBack",
            Action::SignOut => "/Seat/Index/checkOut",
            Action::Leave => unreachable!(),
        };
        let body = self
            .request_json(
                &format!("{endpoint}?bookingId={encoded_id}&LAB_JSON=1"),
                Method::POST,
                None,
                Vec::new(),
            )
            .await?;
        assert_action_success(&body)?;
        Ok(body)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookingRange {
    pub min_begin_time: i64,
    pub max_end_time: i64,
    pub min_duration: i64,
    pub max_duration: i64,
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

fn value_to_i64(value: &Value) -> i64 {
    match value {
        Value::Number(number) => number.as_i64().unwrap_or(0),
        Value::String(text) => text.parse().unwrap_or(0),
        _ => 0,
    }
}

fn find_non_empty_default_items(value: &Value) -> Option<&Vec<Value>> {
    match value {
        Value::Array(items) => items.iter().find_map(find_non_empty_default_items),
        Value::Object(record) => {
            if let Some(items) = record.get("defaultItems").and_then(Value::as_array) {
                if !items.is_empty() {
                    return Some(items);
                }
            }
            record.values().find_map(find_non_empty_default_items)
        }
        _ => None,
    }
}

fn api_token(seat_id: &str, uid: &str, begin_time: i64, duration: i64, api_time: i64) -> String {
    let source = format!(
        "post&/Seat/Index/bookSeats?LAB_JSON=1&api_time{api_time}&beginTime{begin_time}&duration{duration}&is_recommend0&seatBookers[0]{uid}&seats[0]{seat_id}"
    );
    let digest = Md5::digest(source.as_bytes());
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    base64::engine::general_purpose::STANDARD.encode(hex.as_bytes())
}

fn assert_action_success(body: &Value) -> Result<(), HduError> {
    let code = body
        .get("CODE")
        .map(value_to_string)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let result = body
        .get("DATA")
        .and_then(|data| data.get("result"))
        .map(value_to_string)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if code == "ok" && result == "success" {
        return Ok(());
    }
    let message = body
        .get("DATA")
        .and_then(|data| data.get("msg"))
        .map(value_to_string)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            body.get("MESSAGE")
                .map(value_to_string)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "操作失败".into());
    Err(HduError::Library(message))
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
}
