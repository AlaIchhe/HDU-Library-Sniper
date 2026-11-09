use crate::types::{BookingPlan, Weekday};

pub fn valid_weekdays(days: &[i64]) -> Vec<Weekday> {
    let mut days: Vec<Weekday> = days
        .iter()
        .copied()
        .filter(|day| (1..=7).contains(day))
        .map(|day| day as Weekday)
        .collect();
    days.sort_unstable();
    days.dedup();
    days
}

pub fn validate_plan(input: &BookingPlan) -> Vec<String> {
    let mut errors = Vec::new();
    if input.room_type.trim().is_empty() {
        errors.push("房间类型不能为空".to_string());
    }
    if input.room_query.trim().is_empty() {
        errors.push("房间查询参数不能为空".to_string());
    }
    if input.floor_id <= 0 {
        errors.push("楼层无效".to_string());
    }
    if input.seat_num.trim().is_empty() {
        errors.push("座位号不能为空".to_string());
    }
    if !(0..=23).contains(&input.start_hour) {
        errors.push("开始时间无效".to_string());
    }
    if input.duration_hours <= 0 {
        errors.push("时长无效".to_string());
    }
    if valid_weekdays(
        &input
            .weekdays
            .iter()
            .map(|day| i64::from(*day))
            .collect::<Vec<_>>(),
    )
    .is_empty()
    {
        errors.push("至少选择一个星期".to_string());
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> BookingPlan {
        BookingPlan {
            room_type: "自习室".into(),
            room_query: "x".into(),
            floor_id: 1,
            seat_num: "101".into(),
            start_hour: 8,
            duration_hours: 1,
            weekdays: vec![1],
            ..BookingPlan::default()
        }
    }

    #[test]
    fn requires_a_valid_weekday() {
        let mut value = plan();
        value.weekdays.clear();
        assert!(validate_plan(&value).contains(&"至少选择一个星期".to_string()));

        let value = plan();
        assert!(validate_plan(&value).is_empty());
    }

    #[test]
    fn normalizes_weekdays() {
        assert_eq!(valid_weekdays(&[7, 3, 3, 9, 1]), vec![1, 3, 7]);
    }
}
