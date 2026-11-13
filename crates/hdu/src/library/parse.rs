use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookingRange {
    pub min_begin_time: i64,
    pub max_end_time: i64,
    pub min_duration: i64,
    pub max_duration: i64,
}

pub(crate) fn find_non_empty_default_items(value: &Value) -> Option<&Vec<Value>> {
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

pub(crate) fn api_token(
    seat_id: &str,
    uid: &str,
    begin_time: i64,
    duration: i64,
    api_time: i64,
) -> String {
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

/// 动作类接口的成功判定。
/// 实测 2026-11-13：cancelBooking 成功时返回 CODE=ok、MESSAGE=取消预约成功，
/// 但 DATA 中**没有 result 字段**（DATA 只含用户信息）。旧实现强求 result=success，
/// 会把成功取消误判为失败。因此：result 存在时必须为 success；缺失时以 CODE=ok 为准。
/// 限流响应 CODE=1，仍会被 CODE 判定挡住，不受此放宽影响。
pub(crate) fn assert_action_success(body: &Value) -> Result<(), HduError> {
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
    if code == "ok" && (result == "success" || result.is_empty()) {
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
