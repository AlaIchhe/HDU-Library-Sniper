use chrono::{DateTime, Datelike, SecondsFormat, Timelike, Utc};
use chrono_tz::Asia::Shanghai;
use serde_json::Value;

/// 把 JSON 标量转成字符串；对象/数组/null 返回空串。
pub fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

/// 把 JSON 数字或数字字符串转成 i64；无法转换时返回 0。
pub fn value_to_i64(value: &Value) -> i64 {
    match value {
        Value::Number(number) => number.as_i64().unwrap_or(0),
        Value::String(text) => text.parse().unwrap_or(0),
        _ => 0,
    }
}

/// 上海时区的 YYYY/M/D HH:MM:SS，用于前端展示。
pub fn format_zh(value: DateTime<Utc>) -> String {
    let local = value.with_timezone(&Shanghai);
    format!(
        "{}/{}/{} {:02}:{:02}:{:02}",
        local.year(),
        local.month(),
        local.day(),
        local.hour(),
        local.minute(),
        local.second()
    )
}

/// 毫秒时间戳转 RFC 3339（毫秒精度，UTC）。
pub fn format_iso(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn converts_scalars() {
        assert_eq!(value_to_string(&json!("abc")), "abc");
        assert_eq!(value_to_string(&json!(12)), "12");
        assert_eq!(value_to_string(&json!(null)), "");
        assert_eq!(value_to_i64(&json!(12)), 12);
        assert_eq!(value_to_i64(&json!("12")), 12);
        assert_eq!(value_to_i64(&json!("x")), 0);
    }

    #[test]
    fn formats_timestamps() {
        let value = DateTime::from_timestamp_millis(1_700_000_000_000).unwrap();
        assert_eq!(format_zh(value), "2023/11/15 06:13:20");
        assert_eq!(format_iso(1_700_000_000_000), "2023-11-14T22:13:20.000Z");
    }
}
