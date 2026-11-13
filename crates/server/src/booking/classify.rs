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

/// 座位在查询时段是否空闲。
/// 实测（2026-11-13）：POI.state=0 提交成功；state=1/3 提交返回
/// “选择的座位无法预约，可能座位不可用或已经被其他人锁定或占用”。
/// state 可能是字符串或数字，统一按字符串比较。
pub(crate) fn seat_is_free(floors: &[Value], plan: &BookingPlan, seat_num: &str) -> bool {
    let Some(floor) = floors.iter().find(|floor| {
        floor
            .get("seatMap")
            .and_then(|map| map.get("info"))
            .and_then(|info| info.get("id"))
            .map(value_to_i64)
            == Some(plan.floor_id)
    }) else {
        return false;
    };
    let Some(seats) = floor
        .get("seatMap")
        .and_then(|map| map.get("POIs"))
        .and_then(Value::as_array)
    else {
        return false;
    };
    seats.iter().any(|seat| {
        seat.get("title")
            .map(value_to_string)
            .unwrap_or_default()
            .trim()
            == seat_num
            && seat.get("state").map(value_to_string).unwrap_or_default() == "0"
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

/// 锁座请求是否被馆方**接受**（`CODE=ok`），与 `DATA.result` 无关。
///
/// 实测（2026-11-13，docs/HUITU-LIMITS.md §3）：**空闲座位**的 `lockSeats` 也返回
/// `CODE=ok` + `DATA.time>0` + `DATA.result=fail`，紧接着 `bookSeats` 直接成功。
/// 也就是说 `result=fail` 是空闲座位的常态回复，**不能**用它决定是否保留 seatId：
/// 那样 seatId 永远存不下，20:00 座位图持续 404 时就再也提交不出去
/// （2026-11-13 实战复现：预锁 locks=0，随后 12 轮全部空转 86s）。
///
/// 真正该拒绝的是 `CODE != ok`（例如限流 `CODE=1`）——那说明请求本身没被受理。
/// 座位是否可用另由 `seat_is_free`（`POI.state=0`）判定，见 §2。
pub(crate) fn lock_accepted(response: &Result<Value, HduError>) -> bool {
    response.as_ref().is_ok_and(|response| {
        response
            .get("CODE")
            .map(value_to_string)
            .unwrap_or_default()
            .eq_ignore_ascii_case("ok")
    })
}

/// 锁座是否真的把座位锁住了（`DATA.result=success`）。
/// 仅用于日志与审计展示，**不参与是否保留 seatId 的决策**（见 `lock_accepted`）。
pub(crate) fn lock_effective(response: &Result<Value, HduError>) -> bool {
    lock_accepted(response)
        && response.as_ref().is_ok_and(|response| {
            response
                .get("DATA")
                .and_then(|data| data.get("result"))
                .map(value_to_string)
                .unwrap_or_default()
                .eq_ignore_ascii_case("success")
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

/// 座位图查询是否被服务端挡住（而非"座位不存在"之类的确定性失败）。
///
/// 两种都算：
/// - `Http(404)`：并发保护（`CODE=NotFound`），实测瞬时恢复、不累积（§1.1）。
/// - `RequestTimeout`：20:00 拥堵时连接卡死。**必须一起算**——
///   2026-11-13 实战中两次超时都不匹配 404，被上层当成"恢复"，
///   写出假的 `booking_seat_query_recovered`，而馆方其实一直在 404。
///
/// 这个标记只用于审计与拥堵期间冻结写入槽，不改变轮询间隔。
pub(crate) fn is_seat_query_blocked(error: &HduError) -> bool {
    matches!(error, HduError::Http(404) | HduError::RequestTimeout)
}

/// 座位本身不可用（被他人锁定或占用）。两个来源都要认：
/// - 馆方文案（实测见 docs/HUITU-LIMITS.md §2）：
///   `选择的座位无法预约，可能座位不可用或已经被其他人锁定或占用`
/// - 本地按 `POI.state` 预筛的文案：`座位 101 已被占用`
///
/// 只有这类失败才说明预锁锁到的座位失效、该丢锁换座位。
/// 限流、"未到预约时间"、座位图 404 都**不代表座位有问题**——
/// 若据此丢锁，20:00 持续 404 期间就再也解析不出 seatId，整个窗口不再提交。
pub(crate) fn is_seat_unavailable_message(message: &str) -> bool {
    message.contains("座位无法预约")
        || message.contains("已经被其他人锁定")
        || message.contains("座位不可用")
        || message.contains("已被占用")
}
