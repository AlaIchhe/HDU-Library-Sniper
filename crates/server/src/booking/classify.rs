use super::*;

pub(crate) fn is_enabled(item: &PlanListItem) -> bool {
    match item {
        PlanListItem::Single(plan) => plan.enabled,
        PlanListItem::Group(group) => group.enabled,
    }
}

pub(crate) fn plan_members(item: &PlanListItem) -> (String, String, Vec<BookingPlan>) {
    match item {
        PlanListItem::Single(plan) => (plan.id.clone(), "single".into(), vec![plan.clone()]),
        PlanListItem::Group(group) => {
            let mut members = group.members.clone().unwrap_or_default();
            members.sort_by_key(|plan| plan.start_hour);
            (group.id.clone(), "group".into(), members)
        }
    }
}

pub fn member_begin(plan: &BookingPlan, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let local_now = now.with_timezone(&Shanghai);
    let offset = booking_day_offset_for(Some(&plan.room_type));
    let target = (local_now + chrono::Duration::days(offset)).date_naive();
    if !plan
        .weekdays
        .contains(&((target.weekday().number_from_monday()) as u8))
    {
        return None;
    }
    let local = target.and_hms_opt(plan.start_hour.clamp(0, 23) as u32, 0, 0)?;
    Shanghai
        .from_local_datetime(&local)
        .single()
        .map(|value| value.with_timezone(&Utc))
}

pub(crate) fn next_backoff_ms(current: u64, base: u64, max: u64) -> u64 {
    let current = if current > 0 { current } else { base };
    (current * 2).max(base).min(max)
}

pub(crate) fn seat_id_from_floors(
    floors: &[Value],
    plan: &BookingPlan,
    seat_num: &str,
) -> Option<String> {
    let floor = floors.iter().find(|floor| {
        floor
            .get("seatMap")
            .and_then(|map| map.get("info"))
            .and_then(|info| info.get("id"))
            .map(value_to_i64)
            == Some(plan.floor_id)
    })?;
    let seats = floor
        .get("seatMap")
        .and_then(|map| map.get("POIs"))
        .and_then(Value::as_array)?;
    seats.iter().find_map(|seat| {
        (seat
            .get("title")
            .map(value_to_string)
            .unwrap_or_default()
            .trim()
            == seat_num)
            .then(|| seat.get("id").map(value_to_string))
            .flatten()
    })
}

pub(crate) fn response_message(response: &Value) -> String {
    let data = response.get("DATA");
    let message = data
        .and_then(|data| data.get("msg"))
        .map(value_to_string)
        .unwrap_or_default();
    if message.is_empty() {
        response
            .get("MESSAGE")
            .map(value_to_string)
            .unwrap_or_default()
    } else {
        message
    }
}

pub(crate) fn booking_succeeded(response: &Value) -> bool {
    let code = response
        .get("CODE")
        .map(value_to_string)
        .unwrap_or_default();
    let data = response.get("DATA");
    if !code.eq_ignore_ascii_case("ok") {
        return false;
    }
    let result = data
        .and_then(|data| data.get("result"))
        .map(value_to_string)
        .unwrap_or_default();
    result.eq_ignore_ascii_case("success")
        || data
            .and_then(|data| data.get("msg"))
            .map(value_to_string)
            .is_some_and(|message| message.contains("成功"))
}

pub(crate) fn lock_succeeded(response: &Result<Value, HduError>) -> bool {
    response.as_ref().is_ok_and(|response| {
        response
            .get("CODE")
            .map(value_to_string)
            .unwrap_or_default()
            .eq_ignore_ascii_case("ok")
            && response
                .get("DATA")
                .and_then(|data| data.get("time"))
                .map(value_to_i64)
                .unwrap_or(0)
                > 0
    })
}

pub(crate) fn classify_booking_failure(message: &str) -> Option<&'static str> {
    if message.contains("请求过于频繁") || message.contains("非手机端请求过于频繁")
    {
        Some("ban")
    } else if message.contains("请求太频繁了") {
        Some("throttle")
    } else if message.contains("订座流程异常") {
        Some("flow")
    } else {
        None
    }
}

pub(crate) fn is_duplicate_message(message: &str) -> bool {
    message.contains("已有预约") || message.contains("请勿重复") || message.contains("重复预约")
}
