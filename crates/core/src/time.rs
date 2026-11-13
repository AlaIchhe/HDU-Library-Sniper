use chrono::{DateTime, Duration, Timelike, Utc};
use chrono_tz::Asia::Shanghai;

pub const BOOKING_DAY_OFFSET: i64 = 2;
/// 预锁提前量：19:59:00 触发，对启用方案的每个成员各锁一次。
/// 每个成员只请求一次，失败不回退、不兜底，只记日志（见 docs/HUITU-LIMITS.md §8）。
/// 60s 提前量 > HTTP 30s 超时，正常路径每成员约 0.5s + 写入节拍。
pub const BOOKING_PRELOCK_LEAD_SECONDS: i64 = 60;

const BOOKING_ANCHOR_SECONDS: i64 = 20 * 3600;

pub fn booking_day_offset_for(room_type: Option<&str>) -> i64 {
    if room_type.is_some_and(|value| value.contains("生活区")) {
        1
    } else {
        BOOKING_DAY_OFFSET
    }
}

pub fn booking_anchor_delay_seconds(seconds_of_day: i64) -> i64 {
    let mut delay = BOOKING_ANCHOR_SECONDS - seconds_of_day;
    if delay <= 0 {
        delay += 24 * 3600;
    }
    delay
}

pub fn shanghai_seconds_of_day(now: DateTime<Utc>) -> i64 {
    let local = now.with_timezone(&Shanghai);
    i64::from(local.hour()) * 3600 + i64::from(local.minute()) * 60 + i64::from(local.second())
}

pub fn next_booking_anchor(now: DateTime<Utc>) -> DateTime<Utc> {
    now + Duration::seconds(booking_anchor_delay_seconds(shanghai_seconds_of_day(now)))
}

pub fn booking_prelock_delay_seconds(seconds_of_day: i64, lead_seconds: i64) -> i64 {
    let anchor_delay = booking_anchor_delay_seconds(seconds_of_day);
    let anchor_at = seconds_of_day + anchor_delay;
    (anchor_at - lead_seconds - seconds_of_day).max(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::DateTime;

    fn at(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .expect("valid timestamp")
            .with_timezone(&Utc)
    }

    #[test]
    fn living_area_is_one_day_ahead() {
        assert_eq!(booking_day_offset_for(Some("生活区")), 1);
        assert_eq!(booking_day_offset_for(Some("生活区（南楼）")), 1);
    }

    #[test]
    fn other_rooms_use_two_days() {
        assert_eq!(booking_day_offset_for(Some("自习室")), 2);
        assert_eq!(booking_day_offset_for(Some("宋韵云图（自习室）")), 2);
        assert_eq!(booking_day_offset_for(None), 2);
    }

    #[test]
    fn anchor_waits_until_tonight_or_tomorrow() {
        assert_eq!(booking_anchor_delay_seconds(0), 20 * 3600);
        assert_eq!(booking_anchor_delay_seconds(19 * 3600 + 59 * 60 + 59), 1);
        assert_eq!(booking_anchor_delay_seconds(20 * 3600), 24 * 3600);
        assert_eq!(booking_anchor_delay_seconds(21 * 3600), 23 * 3600);
    }

    #[test]
    fn next_anchor_uses_shanghai_wall_clock() {
        assert_eq!(
            next_booking_anchor(at("2026-11-06T14:48:00+08:00")),
            at("2026-11-06T20:00:00+08:00")
        );
        assert_eq!(
            next_booking_anchor(at("2026-11-06T20:00:00+08:00")),
            at("2026-11-07T20:00:00+08:00")
        );
        assert_eq!(
            next_booking_anchor(at("2026-11-06T23:30:00+08:00")),
            at("2026-11-07T20:00:00+08:00")
        );
        assert_eq!(
            shanghai_seconds_of_day(at("2026-11-06T06:48:00Z")),
            14 * 3600 + 48 * 60
        );
    }

    #[test]
    fn prelock_fires_at_1959() {
        let lead = BOOKING_PRELOCK_LEAD_SECONDS;
        assert_eq!(lead, 60);
        // 19:59:00 之前：睡到 19:59:00
        assert_eq!(booking_prelock_delay_seconds(0, lead), 20 * 3600 - 60);
        assert_eq!(booking_prelock_delay_seconds(19 * 3600 + 58 * 60, lead), 60);
        // 19:59:00 起：立即触发，不再等
        assert_eq!(booking_prelock_delay_seconds(19 * 3600 + 59 * 60, lead), 0);
        assert_eq!(
            booking_prelock_delay_seconds(19 * 3600 + 59 * 60 + 59, lead),
            0
        );
        assert_eq!(
            booking_prelock_delay_seconds(20 * 3600, lead),
            24 * 3600 - 60
        );
        assert_eq!(
            booking_prelock_delay_seconds(21 * 3600, lead),
            23 * 3600 - 60
        );
    }

    /// 提前量必须大于 HTTP 单次请求超时：单个成员的请求不会跨过 20:00。
    /// 逐成员预锁不做预算计算，靠这个不变量 + 写入节拍保证整体在锚点前收尾。
    #[test]
    fn prelock_lead_exceeds_the_http_timeout() {
        const HTTP_TIMEOUT_MS: u64 = 30_000;
        assert!(
            (BOOKING_PRELOCK_LEAD_SECONDS as u64) * 1_000 > HTTP_TIMEOUT_MS,
            "提前量必须大于单次请求超时，否则预锁可能跨过 20:00"
        );
    }
}
