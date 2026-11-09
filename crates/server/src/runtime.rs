use axum::{extract::State, http::StatusCode, Json};
use chrono::{DateTime, Utc};
use hdu_sniper_core::json::format_zh;
use hdu_sniper_core::{
    next_booking_anchor, CheckInStatus, NextExecutionTarget, NextTargetKind, PlanListItem,
    RuntimeStatus,
};
use serde::Deserialize;
use serde_json::Value;

use crate::{ApiError, AppState};

const CONSENT_VERSION: &str = "2026-08-02.1";

pub async fn status(State(state): State<AppState>) -> Json<RuntimeStatus> {
    Json(state.scheduler.status())
}

pub async fn booking_run(State(state): State<AppState>) -> Json<Value> {
    Json(state.scheduler.run_now().await)
}

pub async fn next_target(
    State(state): State<AppState>,
) -> Result<Json<NextExecutionTarget>, ApiError> {
    let enabled = state
        .store
        .list_plan_items()?
        .into_iter()
        .find(|item| match item {
            PlanListItem::Single(plan) => plan.enabled,
            PlanListItem::Group(group) => group.enabled,
        });
    let booking = enabled.map(|item| {
        let id = match &item {
            PlanListItem::Single(plan) => plan.id.clone(),
            PlanListItem::Group(group) => group.id.clone(),
        };
        let at = next_booking_anchor(Utc::now());
        (
            at.timestamp_millis(),
            NextExecutionTarget {
                kind: NextTargetKind::Booking,
                label: "预约".into(),
                at: Some(format_zh(at)),
                plan_id: Some(id),
                booking_id: None,
            },
        )
    });
    let checkin = if state.scheduler.auto_check_in_enabled() {
        state.scheduler.next_check_in().map(|(booking_id, at)| {
            let when = DateTime::from_timestamp_millis(at).unwrap_or_else(Utc::now);
            (
                at,
                NextExecutionTarget {
                    kind: NextTargetKind::CheckIn,
                    label: "签到".into(),
                    at: Some(format_zh(when)),
                    plan_id: None,
                    booking_id: Some(booking_id),
                },
            )
        })
    } else {
        None
    };
    let target = match (booking, checkin) {
        (Some((booking_at, _booking)), Some((checkin_at, checkin))) if checkin_at < booking_at => {
            checkin
        }
        (Some((_, booking)), _) => booking,
        (None, Some((_, checkin))) => checkin,
        (None, None) => NextExecutionTarget {
            kind: NextTargetKind::None,
            label: "暂无待执行任务".into(),
            at: None,
            plan_id: None,
            booking_id: None,
        },
    };
    Ok(Json(target))
}

pub async fn get_checkin(State(state): State<AppState>) -> Result<Json<CheckInStatus>, ApiError> {
    Ok(Json(checkin_status(&state)?))
}

#[derive(Debug, Deserialize)]
pub(crate) struct AgreedInput {
    agreed: Option<bool>,
}

pub async fn enable_checkin(
    State(state): State<AppState>,
    Json(input): Json<AgreedInput>,
) -> Result<Json<CheckInStatus>, ApiError> {
    if input.agreed != Some(true) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "启用自动签到需要确认风险协议",
        ));
    }
    state.scheduler.set_auto_check_in(true, true);
    let scheduler = state.scheduler.clone();
    tokio::spawn(async move { scheduler.sync_check_ins().await });
    Ok(Json(checkin_status(&state)?))
}

pub async fn disable_checkin(
    State(state): State<AppState>,
) -> Result<Json<CheckInStatus>, ApiError> {
    state.scheduler.set_auto_check_in(false, false);
    Ok(Json(checkin_status(&state)?))
}

fn checkin_status(state: &AppState) -> Result<CheckInStatus, ApiError> {
    Ok(CheckInStatus {
        enabled: state.scheduler.auto_check_in_enabled(),
        consent_version: CONSENT_VERSION.into(),
        consented_at: state.scheduler.consented_at(),
        last_attempt_at: None,
        last_success_at: None,
        last_message: None,
    })
}
