use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use hdu_sniper_core::PlanListItem;
use hdu_sniper_store::Store;
use serde_json::{json, Value};

mod plans;
use plans::{GroupInput, PlanError, PlanInput};

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
}

pub fn build_router(store: Arc<Store>) -> Router {
    Router::new()
        .route("/api/health", get(health))
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
        .with_state(AppState { store })
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
        build_router(Arc::new(Store::open_in_memory().unwrap()))
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
