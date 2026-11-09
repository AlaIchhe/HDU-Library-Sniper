use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use hdu_sniper_auth::{AuthError, LoginResult};
use hdu_sniper_core::{QrLoginStart, QrLoginStatus, SessionStatus};
use serde::Deserialize;

use crate::{ApiError, AppState};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginInput {
    student_id: Option<String>,
    password: Option<String>,
}

pub async fn status(State(state): State<AppState>) -> Json<SessionStatus> {
    Json(state.auth.status())
}

pub async fn login(
    State(state): State<AppState>,
    Json(input): Json<LoginInput>,
) -> Json<LoginResult> {
    let result = state
        .auth
        .login_password(
            input.student_id.as_deref().unwrap_or(""),
            input.password.as_deref().unwrap_or(""),
        )
        .await;
    if result.success {
        let scheduler = state.scheduler.clone();
        tokio::spawn(async move { scheduler.sync_check_ins().await });
    }
    Json(result)
}

#[derive(Debug, Deserialize)]
pub(crate) struct OpenIdInput {
    openid: Option<String>,
}

pub async fn login_openid(
    State(state): State<AppState>,
    Json(input): Json<OpenIdInput>,
) -> Json<LoginResult> {
    let result = state
        .auth
        .login_with_openid(input.openid.as_deref().unwrap_or(""))
        .await;
    if result.success {
        let scheduler = state.scheduler.clone();
        tokio::spawn(async move { scheduler.sync_check_ins().await });
    }
    Json(result)
}

pub async fn create_qr(State(state): State<AppState>) -> Result<Json<QrLoginStart>, ApiError> {
    state
        .auth
        .clone()
        .create_qr_login()
        .await
        .map(Json)
        .map_err(|error| match error {
            AuthError::Busy => ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "已有二维码等待扫码，请稍后再试",
            ),
            other => ApiError::new(StatusCode::BAD_GATEWAY, other.to_string()),
        })
}

pub async fn qr_status(
    State(state): State<AppState>,
    Path(uuid): Path<String>,
) -> Json<QrLoginStatus> {
    let result = state.auth.poll_qr_login(&uuid);
    if result.status == "confirmed" {
        let scheduler = state.scheduler.clone();
        tokio::spawn(async move { scheduler.sync_check_ins().await });
    }
    Json(result)
}

pub async fn logout(State(state): State<AppState>) -> Json<serde_json::Value> {
    state.auth.logout().await;
    Json(serde_json::json!({ "success": true }))
}
