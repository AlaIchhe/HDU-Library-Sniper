use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use hdu_sniper_core::json::{format_zh, value_to_i64, value_to_string};
use hdu_sniper_core::Booking;
use hdu_sniper_hdu::Action;
use serde_json::{json, Value};

use crate::{ApiError, AppState};

pub async fn current(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let raw = state.auth.client.bookings().await?;
    state.scheduler.observe_bookings(&raw);
    let bookings: Vec<Booking> = raw.iter().filter_map(booking_from_raw).collect();
    Ok(Json(json!({ "bookings": bookings })))
}

pub async fn action(
    State(state): State<AppState>,
    Path((id, action)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let action_name = action.clone();
    let action = match action.as_str() {
        "cancel" => Action::Cancel,
        "check-in" => Action::CheckIn,
        "leave" => Action::Leave,
        "renew" => Action::ComeBack,
        "sign-out" => Action::SignOut,
        _ => return Err(ApiError::new(StatusCode::NOT_FOUND, "not found")),
    };
    state.auth.client.action(action, &id).await?;
    if action_name == "check-in" {
        state.scheduler.note_checked_in(&id);
    } else if action_name == "cancel" {
        state.scheduler.forget(&id);
    }
    Ok(Json(json!({ "success": true, "message": "操作成功" })))
}

fn booking_from_raw(item: &Value) -> Option<Booking> {
    let status = item.get("status").map(value_to_string).unwrap_or_default();
    if ["3", "4", "5", "6", "7", "9"].contains(&status.as_str()) {
        return None;
    }
    let begin = item.get("time").map(value_to_i64).unwrap_or(0) * 1000;
    let begin_seconds = item.get("time").map(value_to_i64).unwrap_or(0);
    let now = item
        .get("nowTime")
        .map(value_to_i64)
        .unwrap_or_else(|| Utc::now().timestamp());
    let limit_ago = item.get("limitSignAgo").map(value_to_i64).unwrap_or(0);
    let limit_back = item.get("limitSignBack").map(value_to_i64).unwrap_or(0);
    let can_check_in =
        status == "0" && now >= begin_seconds - limit_ago && now <= begin_seconds + limit_back;
    let state = if can_check_in {
        "check_in"
    } else {
        match status.as_str() {
            "1" => "in_use",
            "2" => "away",
            _ => "pending",
        }
    };
    let status_label = if can_check_in {
        "可签到"
    } else {
        match status.as_str() {
            "1" => "使用中",
            "2" => "暂离中",
            _ => "待签到",
        }
    };
    let duration = item.get("duration").map(value_to_i64).unwrap_or(0);
    Some(Booking {
        booking_id: item.get("id").map(value_to_string).unwrap_or_default(),
        room_name: item
            .get("roomName")
            .map(value_to_string)
            .unwrap_or_else(|| "未知房间".into()),
        seat_num: item
            .get("seatNum")
            .map(value_to_string)
            .unwrap_or_else(|| "-".into()),
        start_text: if begin > 0 {
            format_zh(DateTime::from_timestamp_millis(begin).unwrap_or_else(Utc::now))
        } else {
            "未知时间".into()
        },
        duration_text: format!("{} 小时", if duration > 0 { duration / 3600 } else { 0 }),
        status: status.clone(),
        state: state.into(),
        status_label: status_label.into(),
        can_cancel: status == "0",
        can_check_in,
        can_sign_out: status == "1" || status == "2",
        can_leave: status == "1",
        can_renew: status == "2",
    })
}
