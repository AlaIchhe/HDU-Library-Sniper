use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use crate::AppState;

const MINUTE: Duration = Duration::from_secs(60);

struct Bucket {
    window_start: Instant,
    count: u32,
}

/// 极简固定窗口限流器。单账号工具，所有客户端共享一个窗口；
/// 将来需要多用户时再改成按 IP 分桶。
pub struct RateLimit {
    buckets: Mutex<HashMap<&'static str, Bucket>>,
}

impl RateLimit {
    pub fn new() -> Self {
        Self {
            buckets: Mutex::new(HashMap::new()),
        }
    }

    pub fn hit(&self, key: &'static str, limit: u32, window: Duration) -> bool {
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let bucket = buckets.entry(key).or_insert_with(|| Bucket {
            window_start: Instant::now(),
            count: 0,
        });
        if bucket.window_start.elapsed() >= window {
            bucket.window_start = Instant::now();
            bucket.count = 0;
        }
        if bucket.count >= limit {
            return false;
        }
        bucket.count += 1;
        true
    }
}

impl Default for RateLimit {
    fn default() -> Self {
        Self::new()
    }
}

fn classify(path: &str) -> (&'static str, u32, Duration) {
    match path {
        "/api/session/login" | "/api/session/openid" => ("login", 5, MINUTE),
        "/api/session/qr" => ("qr", 3, MINUTE),
        "/api/checkin/enable" => ("checkin", 10, MINUTE),
        _ => ("api", 240, MINUTE),
    }
}

pub async fn limit_requests(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    if !path.starts_with("/api/") {
        return next.run(request).await;
    }
    let (key, limit, window) = classify(path);
    if !state.rate.hit(key, limit, window) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, "60")],
            Json(json!({ "detail": "请求过于频繁，请稍后再试" })),
        )
            .into_response();
    }
    next.run(request).await
}
