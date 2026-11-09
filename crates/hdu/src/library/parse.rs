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
