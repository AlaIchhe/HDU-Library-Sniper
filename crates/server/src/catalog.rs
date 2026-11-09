use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Duration, TimeZone, Utc};
use chrono_tz::Asia::Shanghai;
use hdu_sniper_core::{booking_day_offset_for, DurationOptions, FloorOption, RoomTypeOption};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{ApiError, AppState};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FloorsQuery {
    room_query: Option<String>,
    room_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DurationsQuery {
    room_query: Option<String>,
    start_hour: Option<i64>,
}

pub async fn room_types(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let types = state.auth.client.room_types().await?;
    let options: Vec<RoomTypeOption> = types
        .into_iter()
        .map(|item| RoomTypeOption {
            id: item.query.clone(),
            name: item.name,
            query: item.query,
        })
        .collect();
    Ok(Json(json!({ "options": options })))
}

pub async fn floors(
    State(state): State<AppState>,
    Query(query): Query<FloorsQuery>,
) -> Result<Json<Value>, ApiError> {
    let room_query = query.room_query.unwrap_or_default();
    if room_query.trim().is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "缺少房间查询参数"));
    }
    let range = state.auth.client.booking_range(&room_query).await?;
    let lookup = lookup_time(booking_day_offset_for(query.room_type.as_deref()));
    let options: Vec<FloorOption> = state
        .auth
        .client
        .floors(&room_query, lookup, 1)
        .await?
        .iter()
        .filter_map(floor_to_option)
        .collect();
    if options.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "该房间类型当前没有可预约楼层（可能尚未开放预约，请尝试其他房间类型）",
        ));
    }
    Ok(Json(json!({ "options": options, "range": range })))
}

pub async fn durations(
    State(state): State<AppState>,
    Query(query): Query<DurationsQuery>,
) -> Result<Json<DurationOptions>, ApiError> {
    let start_hour = query.start_hour.unwrap_or(-1);
    if !(0..=23).contains(&start_hour) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "开始时间无效"));
    }
    let room_query = query.room_query.unwrap_or_default();
    let range = state.auth.client.booking_range(&room_query).await?;
    let options = (range.min_duration..=range.max_duration).collect();
    Ok(Json(DurationOptions {
        room_query,
        start_hour,
        options,
    }))
}

fn lookup_time(offset: i64) -> DateTime<Utc> {
    let now = Utc::now().with_timezone(&Shanghai);
    let date = (now + Duration::days(offset)).date_naive();
    let local = date.and_hms_opt(8, 0, 0).expect("valid time");
    Shanghai
        .from_local_datetime(&local)
        .single()
        .expect("valid Shanghai time")
        .with_timezone(&Utc)
}

fn floor_to_option(value: &Value) -> Option<FloorOption> {
    let map = value.get("seatMap")?;
    let id = map.get("info")?.get("id").map(value_to_i64)?;
    if id <= 0 {
        return None;
    }
    let mut seat_titles: Vec<String> = map
        .get("POIs")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("title").map(value_to_string))
                .map(|title| title.trim().to_string())
                .filter(|title| !title.is_empty())
                .collect()
        })
        .unwrap_or_default();
    seat_titles.sort();
    seat_titles.dedup();
    Some(FloorOption {
        id,
        name: value
            .get("roomName")
            .map(value_to_string)
            .unwrap_or_else(|| format!("楼层 {id}")),
        seat_count: seat_titles.len() as i64,
        seat_titles,
    })
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
