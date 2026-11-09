//! 本地 HTTP API（axum）：路由、同源守卫、限流与静态资源。

use std::net::IpAddr;
use std::sync::{Arc, OnceLock};

use axum::{
    extract::{Path, Query, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Json, Router,
};
use hdu_sniper_auth::AuthService;
use hdu_sniper_core::PlanListItem;
use hdu_sniper_hdu::HduError;
use hdu_sniper_store::{Store, StoreError};
use serde_json::{json, Value};
use tower_http::services::{ServeDir, ServeFile};

mod booking;
mod bookings;
mod catalog;
pub use booking::BookingExecutor;
pub use scheduler::Scheduler;

mod plans;
mod ratelimit;
mod runtime;
mod scheduler;
mod session;
use plans::{GroupInput, PlanError, PlanInput};
use ratelimit::RateLimit;

#[derive(Debug)]
pub(crate) struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub(crate) fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "detail": self.message }))).into_response()
    }
}

impl From<HduError> for ApiError {
    fn from(error: HduError) -> Self {
        let status = match &error {
            HduError::AuthenticationExpired(_) => StatusCode::UNAUTHORIZED,
            HduError::RequestTimeout => StatusCode::GATEWAY_TIMEOUT,
            _ => StatusCode::BAD_GATEWAY,
        };
        Self::new(status, error.to_string())
    }
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    }
}

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub auth: Arc<AuthService>,
    pub scheduler: Arc<Scheduler>,
    pub rate: Arc<RateLimit>,
}

/// 组装本地 API 路由、守卫、限流与静态资源。
pub fn build_router(
    store: Arc<Store>,
    auth: Arc<AuthService>,
    scheduler: Arc<Scheduler>,
) -> Router {
    auth.install_refresh_callback();
    let state = AppState {
        store,
        auth,
        scheduler,
        rate: Arc::new(RateLimit::new()),
    };
    let public = Router::new()
        .route("/api/health", get(health))
        .route("/api/session", get(session::status))
        .route("/api/session/login", post(session::login))
        .route("/api/session/openid", post(session::login_openid))
        .route("/api/session/qr", post(session::create_qr))
        .route("/api/session/qr/{uuid}/status", get(session::qr_status))
        .route("/api/session/logout", post(session::logout));
    let protected = Router::new()
        .route("/api/audit", get(list_audit))
        .route("/api/plans", get(list_plans).post(create_plan))
        .route(
            "/api/plans/{id}",
            get(get_plan).patch(update_plan).delete(delete_plan),
        )
        .route("/api/plans/{id}/{action}", post(enable_plan))
        .route("/api/groups", post(create_group))
        .route(
            "/api/groups/{id}",
            get(get_group).patch(update_group).delete(delete_group),
        )
        .route("/api/catalog/room-types", get(catalog::room_types))
        .route("/api/catalog/floors", get(catalog::floors))
        .route("/api/catalog/durations", get(catalog::durations))
        .route("/api/bookings/current", get(bookings::current))
        .route("/api/bookings/{id}/{action}", post(bookings::action))
        .route("/api/booking/run", post(runtime::booking_run))
        .route("/api/runtime/status", get(runtime::status))
        .route("/api/runtime/next-target", get(runtime::next_target))
        .route("/api/checkin", get(runtime::get_checkin))
        .route("/api/checkin/enable", post(runtime::enable_checkin))
        .route("/api/checkin/disable", post(runtime::disable_checkin))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));
    Router::new()
        .merge(public)
        .merge(protected)
        .route(
            "/api/{*path}",
            any(|| async {
                (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "detail": "not found" })),
                )
            }),
        )
        .fallback_service(
            ServeDir::new("dist/web").not_found_service(ServeFile::new("dist/web/index.html")),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            ratelimit::limit_requests,
        ))
        .layer(middleware::from_fn(guard_origin))
        .with_state(state)
}

/// 允许的 Host 名：IP 字面量、localhost，以及 HDU_ALLOWED_HOSTS 里显式列出的域名。
/// 反向代理/自定义域名访问时用环境变量追加，例如 HDU_ALLOWED_HOSTS=hdu.lan。
fn extra_allowed_hosts() -> &'static [String] {
    static HOSTS: OnceLock<Vec<String>> = OnceLock::new();
    HOSTS.get_or_init(|| {
        std::env::var("HDU_ALLOWED_HOSTS")
            .map(|value| {
                value
                    .split(',')
                    .map(|item| item.trim().to_ascii_lowercase())
                    .filter(|item| !item.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    })
}

fn host_name(host: &str) -> &str {
    if let Some(rest) = host.strip_prefix('[') {
        return rest.split(']').next().unwrap_or(rest);
    }
    host.split(':').next().unwrap_or(host)
}

fn host_is_allowed(name: &str) -> bool {
    name.eq_ignore_ascii_case("localhost")
        || name == "::1"
        || name.parse::<IpAddr>().is_ok()
        || extra_allowed_hosts().iter().any(|host| host == name)
}

/// 同源守卫：
/// 1. Host 必须是 IP 字面量 / localhost / 显式白名单域名，挡住 DNS rebinding；
/// 2. 带 Origin 的请求必须与 Host 完全一致；
/// 3. Sec-Fetch-Site: cross-site 直接拒绝。
async fn guard_origin(request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let cross_site = request
        .headers()
        .get("sec-fetch-site")
        .and_then(|value| value.to_str().ok())
        == Some("cross-site");

    let name = host_name(host);
    let host_ok = name.is_empty() || host_is_allowed(name);
    let origin_ok = match origin {
        None => true,
        Some(value) => {
            let authority = value.split_once("://").map(|(_, rest)| rest).unwrap_or("");
            !host.is_empty() && !authority.is_empty() && authority.eq_ignore_ascii_case(host)
        }
    };

    if !host_ok || !origin_ok || cross_site {
        tracing::warn!(%host, origin = ?origin, "rejected cross-origin request");
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "detail": "cross-origin request rejected" })),
        )
            .into_response();
    }
    next.run(request).await
}

async fn require_auth(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if state.auth.authenticated() {
        next.run(request).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "detail": "authentication required" })),
        )
            .into_response()
    }
}

async fn list_audit(
    State(state): State<AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Value>, PlanError> {
    let limit = params
        .get("limit")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(20);
    Ok(Json(json!({ "events": state.store.list_audit(limit)? })))
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn list_plans(State(state): State<AppState>) -> Result<Json<Value>, PlanError> {
    Ok(Json(json!({ "plans": state.store.list_plan_items()? })))
}

async fn get_plan(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, PlanError> {
    match state.store.get_plan_item(&id)? {
        Some(plan) => Ok(Json(json!({ "plan": plan }))),
        None => Err(PlanError::NotFound("方案不存在".into())),
    }
}

async fn create_plan(
    State(state): State<AppState>,
    Json(input): Json<PlanInput>,
) -> Result<(StatusCode, Json<Value>), PlanError> {
    let plan = plans::create_plan(&state.store, input)?;
    Ok((StatusCode::CREATED, Json(json!({ "plan": plan }))))
}

async fn update_plan(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<PlanInput>,
) -> Result<Json<Value>, PlanError> {
    let plan = plans::update_plan(&state.store, &id, input)?;
    Ok(Json(json!({ "plan": plan })))
}

async fn delete_plan(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, PlanError> {
    plans::delete_plan_item(&state.store, &id)?;
    Ok(Json(json!({ "success": true })))
}

async fn enable_plan(
    State(state): State<AppState>,
    Path((id, action)): Path<(String, String)>,
) -> Result<Json<Value>, PlanError> {
    let enabled = match action.as_str() {
        "enable" => true,
        "disable" => false,
        _ => return Err(PlanError::NotFound("not found".into())),
    };
    let (plan, disabled_plan_ids) = plans::enable_plan_item(&state.store, &id, enabled)?;
    Ok(Json(json!({
        "plan": plan,
        "disabledPlanIds": disabled_plan_ids,
    })))
}

async fn create_group(
    State(state): State<AppState>,
    Json(input): Json<GroupInput>,
) -> Result<(StatusCode, Json<Value>), PlanError> {
    let group = plans::create_group(
        &state.store,
        input.name.as_deref().unwrap_or(""),
        input.member_plan_ids.as_deref().unwrap_or(&[]),
    )?;
    Ok((StatusCode::CREATED, Json(json!({ "plan": group }))))
}

async fn get_group(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, PlanError> {
    match state.store.get_plan_item(&id)? {
        Some(PlanListItem::Group(group)) => Ok(Json(json!({ "plan": group }))),
        _ => Err(PlanError::NotFound("组合方案不存在".into())),
    }
}

async fn update_group(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<GroupInput>,
) -> Result<Json<Value>, PlanError> {
    let group = plans::update_group(
        &state.store,
        &id,
        input.name.as_deref().unwrap_or(""),
        input.member_plan_ids.as_deref().unwrap_or(&[]),
    )?;
    Ok(Json(json!({ "plan": group })))
}

async fn delete_group(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, PlanError> {
    plans::delete_plan_item(&state.store, &id)?;
    Ok(Json(json!({ "success": true })))
}

impl IntoResponse for PlanError {
    fn into_response(self) -> Response {
        let status =
            StatusCode::from_u16(self.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(json!({ "detail": self.to_string() }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn app() -> Router {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let auth = Arc::new(AuthService::new(store.clone()).unwrap());
        auth.client.set_identity("304174".into(), "陈同学".into());
        let booking = Arc::new(crate::booking::BookingExecutor::new(store.clone()));
        let scheduler = Arc::new(Scheduler::new(store.clone(), auth.clone(), booking));
        build_router(store, auth, scheduler)
    }

    async fn request(
        app: Router,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        let body = match body {
            Some(value) => {
                builder = builder.header("content-type", "application/json");
                Body::from(value.to_string())
            }
            None => Body::empty(),
        };
        let response = app.oneshot(builder.body(body).unwrap()).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    #[tokio::test]
    async fn health_is_ok() {
        let (status, body) = request(app(), "GET", "/api/health", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ok");
    }

    #[tokio::test]
    async fn creates_and_reads_a_plan() {
        let app = app();
        let (status, body) = request(
            app.clone(),
            "POST",
            "/api/plans",
            Some(json!({
                "roomType": "自习室",
                "roomQuery": "q",
                "floorId": 2,
                "seatNum": "101",
                "startHour": 8,
                "durationHours": 2,
                "weekdays": [1, 2, 3]
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let id = body["plan"]["id"].as_str().unwrap().to_string();
        let (status, body) = request(app, "GET", &format!("/api/plans/{id}"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["plan"]["seatNum"], "101");
    }

    #[tokio::test]
    async fn rejects_invalid_plan() {
        let (status, body) = request(app(), "POST", "/api/plans", Some(json!({}))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["detail"]
            .as_str()
            .unwrap()
            .contains("房间类型不能为空"));
    }

    #[tokio::test]
    async fn creates_a_group() {
        let app = app();
        let mut ids = Vec::new();
        for (seat, hour) in [("101", 8), ("102", 10)] {
            let (_, body) = request(
                app.clone(),
                "POST",
                "/api/plans",
                Some(json!({
                    "roomType": "自习室",
                    "roomQuery": "q",
                    "floorId": 2,
                    "seatNum": seat,
                    "startHour": hour,
                    "durationHours": 1,
                    "weekdays": [1, 2, 3]
                })),
            )
            .await;
            ids.push(body["plan"]["id"].as_str().unwrap().to_string());
        }
        let (status, body) = request(
            app,
            "POST",
            "/api/groups",
            Some(json!({"name": "组合", "memberPlanIds": ids})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert_eq!(body["plan"]["kind"], "group");
    }

    async fn request_with(
        app: Router,
        method: &str,
        uri: &str,
        body: Option<Value>,
        headers: &[(&str, &str)],
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        for (key, value) in headers {
            builder = builder.header(*key, *value);
        }
        let body = match body {
            Some(value) => {
                builder = builder.header("content-type", "application/json");
                Body::from(value.to_string())
            }
            None => Body::empty(),
        };
        let response = app.oneshot(builder.body(body).unwrap()).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn rejects_cross_origin_requests() {
        let (status, _) = request_with(
            app(),
            "POST",
            "/api/plans",
            Some(json!({})),
            &[
                ("host", "127.0.0.1:8000"),
                ("origin", "https://evil.example"),
            ],
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn rejects_dns_rebinding_host() {
        let (status, _) = request_with(
            app(),
            "GET",
            "/api/health",
            None,
            &[("host", "evil.example"), ("origin", "http://evil.example")],
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn allows_same_origin_requests() {
        let (status, body) = request_with(
            app(),
            "GET",
            "/api/health",
            None,
            &[
                ("host", "127.0.0.1:8000"),
                ("origin", "http://127.0.0.1:8000"),
            ],
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    #[tokio::test]
    async fn rejects_cross_site_fetch_metadata() {
        let (status, _) = request_with(
            app(),
            "GET",
            "/api/health",
            None,
            &[("host", "127.0.0.1:8000"), ("sec-fetch-site", "cross-site")],
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn rate_limits_login_attempts() {
        let app = app();
        for _ in 0..5 {
            let (status, _) =
                request(app.clone(), "POST", "/api/session/login", Some(json!({}))).await;
            assert_ne!(status, StatusCode::TOO_MANY_REQUESTS);
        }
        let (status, body) = request(app, "POST", "/api/session/login", Some(json!({}))).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    }
}
