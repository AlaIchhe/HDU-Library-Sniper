#![allow(async_fn_in_trait)]

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Datelike, TimeZone, Utc};
use chrono_tz::Asia::Shanghai;
use hdu_sniper_core::json::{value_to_i64, value_to_string};
use hdu_sniper_core::{booking_day_offset_for, BookingPlan, PlanListItem};
use hdu_sniper_hdu::{HduError, LibraryClient};
use hdu_sniper_store::Store;
use serde_json::Value;

mod burst;
mod classify;
mod execute;
mod types;

#[cfg(test)]
pub use classify::member_begin;
pub use types::*;

type SleepFn = Arc<dyn Fn(u64) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

const DEFAULT_INTERVAL_MS: u64 = 4_000;
const MAX_BACKOFF_MS: u64 = 5 * 60_000;
const THROTTLE_MS: u64 = 15_000;
pub const ACCOUNT_BAN_MS: u64 = 10 * 60_000;

/// 预约执行器：查询座位、锁座、提交并判定结果。
pub struct BookingExecutor {
    store: Arc<Store>,
    interval_ms: AtomicU64,
    next_slot: Mutex<Instant>,
    sleep: SleepFn,
    prelock_aborted: AtomicBool,
}

impl BookingExecutor {
    pub fn new(store: Arc<Store>) -> Self {
        Self::with_sleep(
            store,
            Arc::new(|ms| Box::pin(tokio::time::sleep(Duration::from_millis(ms)))),
        )
    }

    pub fn with_sleep(store: Arc<Store>, sleep: SleepFn) -> Self {
        Self {
            store,
            interval_ms: AtomicU64::new(DEFAULT_INTERVAL_MS),
            next_slot: Mutex::new(Instant::now()),
            sleep,
            prelock_aborted: AtomicBool::new(false),
        }
    }

    pub fn set_interval_ms(&self, interval_ms: u64) {
        self.interval_ms.store(interval_ms, Ordering::Relaxed);
    }

    pub fn abort_prelock(&self) {
        self.prelock_aborted.store(true, Ordering::Relaxed);
    }

    async fn sleep_ms(&self, ms: u64) {
        (self.sleep)(ms).await;
    }

    async fn paced<F, Fut, T>(&self, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let now = Instant::now();
        let interval = Duration::from_millis(self.interval_ms.load(Ordering::Relaxed));
        let wait = {
            let mut slot = self.next_slot.lock().expect("pacing slot poisoned");
            let target = (*slot).max(now);
            *slot = target + interval;
            target.saturating_duration_since(now)
        };
        if !wait.is_zero() {
            self.sleep_ms(wait.as_millis() as u64).await;
        }
        f().await
    }
}

enum Confirm {
    Found(Option<Value>),
    Absent,
    Unknown,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Timelike};
    use hdu_sniper_core::{PlanKind, Weekday};
    use serde_json::json;
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicUsize;

    fn plan() -> BookingPlan {
        BookingPlan {
            id: "p1".into(),
            kind: PlanKind::Single,
            room_type: "自习室".into(),
            room_query: "space_category[category_id]=1&space_category[content_id]=91".into(),
            floor_id: 3,
            floor_name: "三楼".into(),
            seat_num: "101".into(),
            fallback_seats: vec!["102".into()],
            start_hour: 8,
            duration_hours: 12,
            weekdays: (1..=7).collect::<Vec<Weekday>>(),
            enabled: true,
            created_at: "2026-09-05T00:00:00.000Z".into(),
            updated_at: "2026-09-05T00:00:00.000Z".into(),
        }
    }

    struct Fake {
        bookings: Mutex<Option<String>>,
        booking_times: Mutex<Vec<Value>>,
        responses: Mutex<VecDeque<Value>>,
        floor_error: Mutex<Option<String>>,
        book_calls: AtomicUsize,
        lock_calls: AtomicUsize,
    }

    impl Fake {
        fn new() -> Self {
            Self {
                bookings: Mutex::new(None),
                booking_times: Mutex::new(Vec::new()),
                responses: Mutex::new(VecDeque::new()),
                floor_error: Mutex::new(None),
                book_calls: AtomicUsize::new(0),
                lock_calls: AtomicUsize::new(0),
            }
        }
    }

    impl BookingClient for Fake {
        async fn bookings(&self) -> Result<Vec<Value>, HduError> {
            if let Some(error) = self.bookings.lock().unwrap().clone() {
                return Err(HduError::Library(error));
            }
            Ok(self.booking_times.lock().unwrap().clone())
        }

        async fn floors(
            &self,
            _room_query: &str,
            _lookup_time: DateTime<Utc>,
            _duration_hours: i64,
        ) -> Result<Vec<Value>, HduError> {
            if let Some(error) = self.floor_error.lock().unwrap().clone() {
                return Err(HduError::Library(error));
            }
            Ok(vec![json!({
                "seatMap": {
                    "info": {"id": 3},
                    "POIs": [{"title": "101", "id": "seat-1"}, {"title": "102", "id": "seat-2"}]
                }
            })])
        }

        async fn book_seat(
            &self,
            _seat_id: &str,
            _begin_time: DateTime<Utc>,
            _duration_hours: i64,
        ) -> Result<Value, HduError> {
            self.book_calls.fetch_add(1, Ordering::SeqCst);
            if let Some(response) = self.responses.lock().unwrap().pop_front() {
                Ok(response)
            } else {
                Ok(json!({"CODE": "ok", "DATA": {"result": "success"}}))
            }
        }

        async fn lock_seat(
            &self,
            _seat_id: &str,
            _begin_time: DateTime<Utc>,
            _duration_hours: i64,
        ) -> Result<Value, HduError> {
            self.lock_calls.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"CODE": "ok", "DATA": {"time": 1789779600}}))
        }

        async fn unlock_all_seats(&self) -> Result<Value, HduError> {
            Ok(json!({"CODE": "ok"}))
        }
    }

    fn executor(store: Arc<Store>) -> BookingExecutor {
        let executor = BookingExecutor::with_sleep(store, Arc::new(|_ms| Box::pin(async {})));
        executor.set_interval_ms(0);
        executor
    }

    #[test]
    fn member_begin_uses_shanghai_midnight_and_weekday() {
        let now = Shanghai
            .with_ymd_and_hms(2026, 11, 5, 12, 0, 0)
            .single()
            .unwrap()
            .with_timezone(&Utc);
        let begin = member_begin(&plan(), now).unwrap();
        let local = begin.with_timezone(&Shanghai);
        assert_eq!(local.date_naive().to_string(), "2026-11-07");
        assert_eq!(local.hour(), 8);
    }

    #[test]
    fn member_begin_skips_disabled_weekday() {
        let mut plan = plan();
        plan.weekdays = vec![1];
        let now = Shanghai
            .with_ymd_and_hms(2026, 11, 5, 12, 0, 0)
            .single()
            .unwrap()
            .with_timezone(&Utc);
        assert!(member_begin(&plan, now).is_none());
    }

    #[tokio::test]
    async fn skips_a_slot_that_is_already_booked() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let plan = plan();
        let begin = member_begin(&plan, Utc::now()).unwrap().timestamp();
        store.save_plan(&plan).unwrap();
        let client = Fake::new();
        *client.booking_times.lock().unwrap() = vec![json!({"time": begin})];
        let executor = executor(store);
        let result = executor.run(&client).await;
        assert!(result.success);
        assert_eq!(client.book_calls.load(Ordering::SeqCst), 0);
        assert!(result.members[0].message.contains("已有预约"));
    }

    #[tokio::test]
    async fn books_the_primary_seat() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        let executor = executor(store);
        let result = executor.run(&client).await;
        assert!(result.success, "{}", result.message);
        assert_eq!(client.book_calls.load(Ordering::SeqCst), 1);
        assert_eq!(result.members[0].seat_num.as_deref(), Some("101"));
    }

    #[tokio::test]
    async fn retries_until_the_window_opens() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        client
            .responses
            .lock()
            .unwrap()
            .push_back(json!({"CODE": "error", "MESSAGE": "未到预约时间"}));
        client
            .responses
            .lock()
            .unwrap()
            .push_back(json!({"CODE": "error", "MESSAGE": "未到预约时间"}));
        let executor = executor(store);
        let result = executor.run_burst(&client, 0, 5_000).await;
        assert!(result.success, "{}", result.message);
        assert_eq!(client.book_calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn stops_on_account_ban() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        client
            .responses
            .lock()
            .unwrap()
            .push_back(json!({"CODE": "1", "MESSAGE": "请求过于频繁，请10分钟后再试"}));
        let executor = executor(store);
        let result = executor.run_burst(&client, 0, 60_000).await;
        assert!(!result.success);
        assert!(result.members[0].blocked);
        assert_eq!(client.book_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn unverified_when_booking_list_is_down() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        *client.bookings.lock().unwrap() = Some("network down".into());
        client
            .responses
            .lock()
            .unwrap()
            .push_back(json!({"CODE": "1", "MESSAGE": "已有预约，请勿重复预约！"}));
        let executor = executor(store);
        let result = executor.run(&client).await;
        assert!(!result.success);
        assert!(result.members[0].unverified);
    }
}
