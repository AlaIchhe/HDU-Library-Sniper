use std::sync::Arc;

use axum::{
    extract::{Path, Query, Request, State},
    http::StatusCode,
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
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

mod booking;
mod bookings;
mod catalog;
pub use booking::BookingExecutor;
pub use scheduler::Scheduler;

mod plans;
mod runtime;
mod scheduler;
mod session;
use plans::{GroupInput, PlanError, PlanInput};

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
}

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
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state)
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
}
