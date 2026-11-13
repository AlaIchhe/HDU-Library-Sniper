#![allow(async_fn_in_trait)]

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
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

/// 座位图查询与重试的轮询间隔。
/// 实测 2026-11-13：searchSeats **无速率限制**——零间隔背靠背 60 次全部 200（3.4 rps）。
/// 所以读请求之间不需要任何人为节流，秒级间隔没有实测依据，只是白等。
/// 唯一需要等待的信号是并发保护 404（`{"CODE":"NotFound"}`）：它不累积、不封禁，
/// 并发退去即刻恢复。取 300ms 只是为了在 20:00 全校拥堵（用户实况持续 1–2 分钟）
/// 时不退化成忙循环——约 400 次探测覆盖 2 分钟，恢复检测最多晚 300ms。
const POLL_MS: u64 = 300;
/// 写入路径（lockSeats / bookSeats）的最小间隔，实测确定，见 docs/HUITU-LIMITS.md。
/// 实测 2026-11-13：亚秒级连打第 2 次 throttle、第 3 次封号 10 分钟；
/// 3s 在刚打过一轮后第 2 次即封号；5s 首轮 8 次通过，但紧接的第二轮第 6 次封号。
/// 写入额度是累积桶而非单次间隔判定，5s 不可持续；10s 在连续 12 次写入中未被限流。
/// 但 10s 不是绝对安全线：桶被前一轮消耗后，10s 的第 2 次写入即封号（实测 §2.1）。
/// 失败提交同样计入额度，故选座先按 state 预筛，且命中 ban 必须立即停手。
const WRITE_INTERVAL_MS: u64 = 10_000;
pub const ACCOUNT_BAN_MS: u64 = 10 * 60_000;

/// 预约执行器：查询座位、锁座、提交并判定结果。
pub struct BookingExecutor {
    store: Arc<Store>,
    write_interval_ms: AtomicU64,
    write_slot: Mutex<Instant>,
    sleep: SleepFn,
    /// 19:59:00 预锁的结果（每个成员一条），由 20:00 的正式预约消费。
    locked_seats: Mutex<Vec<BookingLock>>,
    /// 测试用：只记录轮询睡眠，不含请求节拍的等待。
    #[cfg(test)]
    poll_log: Option<Arc<Mutex<Vec<u64>>>>,
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
            write_interval_ms: AtomicU64::new(WRITE_INTERVAL_MS),
            write_slot: Mutex::new(Instant::now()),
            sleep,
            locked_seats: Mutex::new(Vec::new()),
            #[cfg(test)]
            poll_log: None,
        }
    }

    #[cfg(test)]
    fn record_polls(&mut self) -> Arc<Mutex<Vec<u64>>> {
        let log = Arc::new(Mutex::new(Vec::new()));
        self.poll_log = Some(log.clone());
        log
    }

    /// 测试用：关闭写入节拍（读路径本来就没有节拍）。
    pub fn set_write_interval_ms(&self, interval_ms: u64) {
        self.write_interval_ms.store(interval_ms, Ordering::Relaxed);
    }

    async fn sleep_ms(&self, ms: u64) {
        (self.sleep)(ms).await;
    }

    /// 写入请求节拍（锁座、提交预约）。实测写入是累积额度桶，必须限速。
    /// 读路径无速率限制，故不设节拍，直接发。
    async fn paced_write<F, Fut, T>(&self, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let now = Instant::now();
        let interval = Duration::from_millis(self.write_interval_ms.load(Ordering::Relaxed));
        let wait = {
            let mut slot = self.write_slot.lock().expect("pacing slot poisoned");
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
        /// 仅首次 floors 返回该错误，之后恢复（模拟瞬时并发保护）
        floor_error_once: Mutex<Option<String>>,
        /// 座位 state 覆盖：title -> state（实测 0=空闲，1/3=已占用）
        seat_states: Mutex<std::collections::HashMap<String, String>>,
        /// lockSeats 的 DATA.result，实测失败时为 fail 但 time 仍 >0
        lock_result: Mutex<String>,
        /// lockSeats 的顶层 MESSAGE，用于模拟预锁阶段命中限流
        lock_message: Mutex<Option<String>>,
        book_calls: AtomicUsize,
        lock_calls: AtomicUsize,
        booked_seats: Mutex<Vec<String>>,
        floors_calls: AtomicUsize,
    }

    impl Fake {
        fn new() -> Self {
            Self {
                bookings: Mutex::new(None),
                booking_times: Mutex::new(Vec::new()),
                responses: Mutex::new(VecDeque::new()),
                floor_error: Mutex::new(None),
                floor_error_once: Mutex::new(None),
                seat_states: Mutex::new(std::collections::HashMap::new()),
                lock_result: Mutex::new("success".into()),
                lock_message: Mutex::new(None),
                book_calls: AtomicUsize::new(0),
                lock_calls: AtomicUsize::new(0),
                booked_seats: Mutex::new(Vec::new()),
                floors_calls: AtomicUsize::new(0),
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
                return Err(hdu_error_from_text(&error));
            }
            if let Some(error) = self.floor_error_once.lock().unwrap().take() {
                return Err(hdu_error_from_text(&error));
            }
            self.floors_calls.fetch_add(1, Ordering::SeqCst);
            let states = self.seat_states.lock().unwrap();
            let state_of = |title: &str| states.get(title).cloned().unwrap_or_else(|| "0".into());
            Ok(vec![json!({
                "seatMap": {
                    "info": {"id": 3},
                    // 实测：真实 POI 必带 state，0=空闲，1/3=已被锁定或占用
                    "POIs": [
                        {"title": "101", "id": "seat-1", "state": state_of("101")},
                        {"title": "102", "id": "seat-2", "state": state_of("102")}
                    ]
                }
            })])
        }

        async fn book_seat(
            &self,
            seat_id: &str,
            _begin_time: DateTime<Utc>,
            _duration_hours: i64,
        ) -> Result<Value, HduError> {
            self.book_calls.fetch_add(1, Ordering::SeqCst);
            self.booked_seats.lock().unwrap().push(seat_id.to_string());
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
            // 实测：锁座失败时 CODE 仍是 ok、DATA.time 仍 >0，只有 result=fail 能区分
            let result = self.lock_result.lock().unwrap().clone();
            if let Some(message) = self.lock_message.lock().unwrap().clone() {
                return Ok(json!({"CODE": "1", "MESSAGE": message}));
            }
            Ok(json!({"CODE": "ok", "DATA": {"result": result, "time": 1789779600}}))
        }

        async fn unlock_all_seats(&self) -> Result<Value, HduError> {
            Ok(json!({"CODE": "ok"}))
        }
    }

    /// 把夹具里的错误文案还原成真实错误变体：
    /// 实测 404 由 `HduError::Http(404)` 承载，必须保留变体才能被上层识别。
    fn hdu_error_from_text(text: &str) -> HduError {
        match text.trim() {
            "HTTP 404" => HduError::Http(404),
            other => HduError::Library(other.to_string()),
        }
    }

    fn executor(store: Arc<Store>) -> BookingExecutor {
        let executor = BookingExecutor::with_sleep(store, Arc::new(|_ms| Box::pin(async {})));
        executor.set_write_interval_ms(0);
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
        let result = executor.run_burst(&client, 5_000).await;
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
        let result = executor.run_burst(&client, 60_000).await;
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

    // ===== 以下用例由 2026-11-13 真实馆方实测驱动，见 docs/HUITU-LIMITS.md =====

    /// 实测：state=1/3 的座位提交必然失败且消耗写入额度（3 次即封号）。
    /// 主座位被占时必须跳到备选，且不对已占座位发起提交。
    #[tokio::test]
    async fn skips_occupied_seat_and_books_the_fallback() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        client
            .seat_states
            .lock()
            .unwrap()
            .insert("101".into(), "1".into());
        let executor = executor(store);
        let result = executor.run(&client).await;
        assert!(result.success, "{}", result.message);
        assert_eq!(result.members[0].seat_num.as_deref(), Some("102"));
        assert_eq!(client.book_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            client.booked_seats.lock().unwrap().as_slice(),
            ["seat-2"],
            "已占座位不得发起提交"
        );
    }

    /// 实测：所有候选座位都被占用时，一次写入都不该发出。
    #[tokio::test]
    async fn makes_no_write_when_every_seat_is_occupied() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        {
            let mut states = client.seat_states.lock().unwrap();
            states.insert("101".into(), "1".into());
            states.insert("102".into(), "3".into());
        }
        let executor = executor(store);
        let result = executor.run(&client).await;
        assert!(!result.success);
        assert_eq!(client.book_calls.load(Ordering::SeqCst), 0);
        assert!(result.members[0].message.contains("已被占用"));
    }

    /// 实测：座位被他人占用时 lockSeats 仍返回 CODE=ok + DATA.time>0，
    /// 只有 DATA.result=fail 能区分，不得据此认为预锁成功，也不得把失败锁存为提示。
    #[tokio::test]
    async fn lock_with_result_fail_is_not_a_success() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        *client.lock_result.lock().unwrap() = "fail".into();
        let executor = executor(store.clone());
        let result = executor.lock_once(&client).await;
        assert!(!result.success, "result=fail 不能算预锁成功");
        assert_eq!(
            client.lock_calls.load(Ordering::SeqCst),
            1,
            "单成员只发一次，不重试"
        );
        assert!(result.locks.is_empty(), "失败的锁不得存为座位提示");
        assert!(
            result.message.contains("锁座未生效"),
            "实际：{}",
            result.message
        );
    }

    /// 预锁必须被正式预约消费：20:00 优先提交锁到的座位，用预锁已知的 seatId，
    /// 不依赖当轮的座位图解析（20:00 座位图可能持续 404，解析不出来）。
    #[tokio::test]
    async fn prelock_is_consumed_by_the_booking_burst() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let mut plan = plan();
        plan.seat_num = "102".into(); // 锁定备选座位，便于区分是否真的用了预锁
        plan.fallback_seats = vec!["101".into()];
        store.save_plan(&plan).unwrap();
        let client = Fake::new();
        let executor = executor(store);
        let lock = executor.lock_once(&client).await;
        assert!(lock.success, "{}", lock.message);
        let floors_before = client.floors_calls.load(Ordering::SeqCst);

        let result = executor.run_burst(&client, 5_000).await;
        assert!(result.success, "{}", result.message);
        assert_eq!(result.members[0].seat_num.as_deref(), Some("102"));
        assert_eq!(
            client.booked_seats.lock().unwrap().as_slice(),
            ["seat-2"],
            "应提交预锁锁定的座位"
        );
        assert!(client.floors_calls.load(Ordering::SeqCst) > floors_before);
    }

    /// 预锁失效（座位被占）时必须丢锁并按备选重试，不能死磕同一座位。
    #[tokio::test]
    async fn drops_a_stale_prelock_and_retries_another_seat() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        let executor = executor(store);
        let lock = executor.lock_once(&client).await;
        assert!(lock.success);
        assert_eq!(lock.locks[0].seat_num, "101");
        // 预锁后该座位被别人占走
        client
            .seat_states
            .lock()
            .unwrap()
            .insert("101".into(), "1".into());
        let result = executor.run_burst(&client, 5_000).await;
        assert!(result.success, "{}", result.message);
        assert_eq!(result.members[0].seat_num.as_deref(), Some("102"));
    }

    /// 固定轮询：失败间隔恒定，不随失败次数翻倍。
    /// 只留一个空闲候选，使每轮恰好一次提交，便于逐轮断言节奏。
    #[tokio::test]
    async fn polls_at_a_fixed_interval_without_backoff() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let mut plan = plan();
        plan.fallback_seats.clear();
        store.save_plan(&plan).unwrap();
        let client = Fake::new();
        for _ in 0..3 {
            client
                .responses
                .lock()
                .unwrap()
                .push_back(json!({"CODE": "error", "MESSAGE": "未到预约时间"}));
        }
        let mut executor = BookingExecutor::with_sleep(store, Arc::new(|_ms| Box::pin(async {})));
        let polls = executor.record_polls();
        let result = executor.run_burst(&client, 60_000).await;
        assert!(result.success, "{}", result.message);
        assert_eq!(client.book_calls.load(Ordering::SeqCst), 4);
        let sleeps = polls.lock().unwrap().clone();
        assert_eq!(
            sleeps,
            vec![POLL_MS, POLL_MS, POLL_MS],
            "轮询间隔必须恒定，实际 {sleeps:?}"
        );
    }

    /// 成功即结束：首轮成功后不得再有任何轮询睡眠或多余请求。
    #[tokio::test]
    async fn success_ends_polling_immediately() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        let mut executor = BookingExecutor::with_sleep(store, Arc::new(|_ms| Box::pin(async {})));
        let polls = executor.record_polls();
        let result = executor.run_burst(&client, 60_000).await;
        assert!(result.success, "{}", result.message);
        assert!(
            polls.lock().unwrap().is_empty(),
            "成功后不得再轮询，实际 {:?}",
            polls.lock().unwrap()
        );
        assert_eq!(client.book_calls.load(Ordering::SeqCst), 1);
        assert_eq!(client.floors_calls.load(Ordering::SeqCst), 1);
    }

    /// 组合方案全部成员成功即结束，不为已成功的成员重复提交。
    #[tokio::test]
    async fn group_success_ends_polling_immediately() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let mut a = plan();
        a.start_hour = 8;
        a.duration_hours = 4;
        a.fallback_seats.clear();
        let mut b = plan();
        b.id = "p2".into();
        b.seat_num = "102".into();
        b.start_hour = 20;
        b.duration_hours = 2;
        b.fallback_seats.clear();
        store.save_plan(&a).unwrap();
        store.save_plan(&b).unwrap();
        store
            .save_group(&hdu_sniper_core::BookingGroup {
                id: "g1".into(),
                kind: hdu_sniper_core::PlanKind::Group,
                name: "晚自习".into(),
                member_plan_ids: vec!["p1".into(), "p2".into()],
                members: Some(vec![a, b]),
                weekdays: (1..=7).collect(),
                enabled: true,
                created_at: "2026-09-05T00:00:00.000Z".into(),
                updated_at: "2026-09-05T00:00:00.000Z".into(),
            })
            .unwrap();
        store.set_only_enabled("g1", true).unwrap();
        let client = Fake::new();
        let mut executor = BookingExecutor::with_sleep(store, Arc::new(|_ms| Box::pin(async {})));
        let polls = executor.record_polls();
        let result = executor.run_burst(&client, 60_000).await;
        assert!(result.success, "{}", result.message);
        assert!(
            polls.lock().unwrap().is_empty(),
            "全部成员成功后不得再轮询，实际 {:?}",
            polls.lock().unwrap()
        );
        assert_eq!(
            client.book_calls.load(Ordering::SeqCst),
            2,
            "每成员恰好一次"
        );
    }

    /// 今日不在方案的重复日期内：没有可执行成员，必须立即结束。
    /// 回归：旧实现把 members 为空当作"还有待办"，整个窗口空转（实测 2s 内 17522 轮）。
    #[tokio::test]
    async fn no_actionable_member_ends_polling_immediately() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let mut plan = plan();
        let target = (Utc::now().with_timezone(&Shanghai) + chrono::Duration::days(2))
            .weekday()
            .number_from_monday() as u8;
        plan.weekdays = (1..=7).filter(|day| *day != target).collect();
        store.save_plan(&plan).unwrap();
        let client = Fake::new();
        let mut executor = BookingExecutor::with_sleep(store, Arc::new(|_ms| Box::pin(async {})));
        let polls = executor.record_polls();
        let started = Instant::now();
        let result = executor.run_burst(&client, 60_000).await;
        assert!(!result.success);
        assert!(
            polls.lock().unwrap().is_empty(),
            "无可执行成员时不得轮询，实际 {} 轮",
            polls.lock().unwrap().len()
        );
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "必须立即返回，实际耗时 {:?}",
            started.elapsed()
        );
        assert_eq!(client.book_calls.load(Ordering::SeqCst), 0);
        assert!(
            result.message.contains("重复日期"),
            "应说明原因，实际：{}",
            result.message
        );
    }

    /// 终态失败（时间冲突）即结束，不再重试。
    #[tokio::test]
    async fn terminal_failure_ends_polling_immediately() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let mut plan = plan();
        plan.fallback_seats.clear();
        store.save_plan(&plan).unwrap();
        let client = Fake::new();
        client.responses.lock().unwrap().push_back(
            json!({"CODE":"ParamError","DATA":{"result":"fail","msg":"已有预约，请勿重复预约！"}}),
        );
        let mut executor = BookingExecutor::with_sleep(store, Arc::new(|_ms| Box::pin(async {})));
        let polls = executor.record_polls();
        let result = executor.run_burst(&client, 60_000).await;
        assert!(!result.success);
        assert!(
            polls.lock().unwrap().is_empty(),
            "终态后不得再轮询，实际 {:?}",
            polls.lock().unwrap()
        );
        assert_eq!(client.book_calls.load(Ordering::SeqCst), 1);
    }

    /// 实测：throttle 文案不再抬高睡眠，仍按固定间隔轮询。
    #[tokio::test]
    async fn throttle_message_does_not_extend_the_poll_interval() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let mut plan = plan();
        plan.fallback_seats.clear();
        store.save_plan(&plan).unwrap();
        let client = Fake::new();
        client
            .responses
            .lock()
            .unwrap()
            .push_back(json!({"CODE": "1", "MESSAGE": "请求太频繁了，请稍后再试"}));
        let mut executor = BookingExecutor::with_sleep(store, Arc::new(|_ms| Box::pin(async {})));
        let polls = executor.record_polls();
        let result = executor.run_burst(&client, 60_000).await;
        assert!(result.success, "{}", result.message);
        // 旧实现把 throttle 抬到 15s；现在应与其他失败一样恒定
        assert_eq!(polls.lock().unwrap().as_slice(), [POLL_MS]);
    }

    /// 实测：提交前不强制重查座位图。故座位图查询失败（如并发保护返回的 404）时，
    /// 若已有预锁座位提示，仍应直接提交，而不是整轮放弃。
    #[tokio::test]
    async fn submits_the_prelocked_seat_when_the_seat_map_query_fails() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        let executor = executor(store);
        let lock = executor.lock_once(&client).await;
        assert!(lock.success, "{}", lock.message);
        // 预锁之后座位图开始返回 404（issue #4：服务端并发保护，CODE=NotFound）
        *client.floor_error.lock().unwrap() = Some("HTTP 404".into());
        let result = executor.run_burst(&client, 5_000).await;
        assert!(result.success, "{}", result.message);
        assert_eq!(
            client.booked_seats.lock().unwrap().as_slice(),
            ["seat-1"],
            "查询失败时应提交预锁已知的 seatId"
        );
    }

    /// 20:00 的真实情形：座位图**持续** 404，且首次提交返回普通业务失败。
    /// 预锁必须一直被保留并反复提交——它是 404 期间唯一的 seatId 来源。
    /// 回归：旧实现在任何非 terminal 失败后都丢锁，第二轮起再也解析不出 seatId，
    /// 整个窗口退化成只读不提交（实测复现：book_calls 停在 1）。
    #[tokio::test]
    async fn keeps_submitting_the_prelocked_seat_while_404_persists() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let mut plan = plan();
        plan.fallback_seats.clear();
        store.save_plan(&plan).unwrap();
        let client = Fake::new();
        let mut executor = BookingExecutor::with_sleep(store, Arc::new(|_ms| Box::pin(async {})));
        let _polls = executor.record_polls();
        let lock = executor.lock_once(&client).await;
        assert!(lock.success, "{}", lock.message);
        // 20:00：座位图持续 404，且前两次提交都因"未到预约时间"失败
        *client.floor_error.lock().unwrap() = Some("HTTP 404".into());
        for _ in 0..2 {
            client
                .responses
                .lock()
                .unwrap()
                .push_back(json!({"CODE": "error", "MESSAGE": "未到预约时间"}));
        }
        let result = executor.run_burst(&client, 60_000).await;
        assert!(result.success, "{}", result.message);
        assert_eq!(
            client.book_calls.load(Ordering::SeqCst),
            3,
            "404 期间必须持续提交预锁座位，而不是只提交一次"
        );
        assert_eq!(
            client.booked_seats.lock().unwrap().as_slice(),
            ["seat-1", "seat-1", "seat-1"],
            "每轮都应提交同一个预锁 seatId"
        );
    }

    /// 404 期间即使本轮成功提交了预锁座位，busy 标记也不能被提交结果覆盖：
    /// 上层要靠它冻结写入槽，否则恢复瞬间会连发提交（实测 3 次即封号）。
    #[tokio::test]
    async fn busy_flag_survives_a_submit_in_the_same_round() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        let mut executor = BookingExecutor::with_sleep(store, Arc::new(|_ms| Box::pin(async {})));
        let _polls = executor.record_polls();
        let lock = executor.lock_once(&client).await;
        assert!(lock.success, "{}", lock.message);
        // 座位图 404，但预锁 seatId 已知 → 本轮仍提交且成功
        *client.floor_error.lock().unwrap() = Some("HTTP 404".into());
        *executor.write_slot.lock().unwrap() = Instant::now() - Duration::from_secs(300);
        let result = executor.run_burst(&client, 5_000).await;
        assert!(result.success, "{}", result.message);
        let slot = *executor.write_slot.lock().unwrap();
        assert!(
            slot >= Instant::now() - Duration::from_secs(1),
            "提交成功也不能丢掉 busy 标记，否则写入槽不会被冻结"
        );
    }

    /// 只有"座位不可用"才丢锁：限流文案不代表座位有问题，预锁必须留着。
    #[tokio::test]
    async fn throttle_does_not_discard_the_prelock() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let mut plan = plan();
        plan.fallback_seats.clear();
        store.save_plan(&plan).unwrap();
        let client = Fake::new();
        let mut executor = BookingExecutor::with_sleep(store, Arc::new(|_ms| Box::pin(async {})));
        let _polls = executor.record_polls();
        assert!(executor.lock_once(&client).await.success);
        // 首轮限流，次轮成功；座位图随后 404，只有预锁能给出 seatId
        client
            .responses
            .lock()
            .unwrap()
            .push_back(json!({"CODE": "1", "MESSAGE": "请求太频繁了，请稍后再试"}));
        *client.floor_error.lock().unwrap() = Some("HTTP 404".into());
        let result = executor.run_burst(&client, 60_000).await;
        assert!(result.success, "{}", result.message);
        assert_eq!(client.book_calls.load(Ordering::SeqCst), 2);
    }

    /// 查询失败且没有预锁时，保留原始查询错误，不误报“未找到可用座位”。
    #[tokio::test]
    async fn keeps_the_query_error_when_no_prelock_exists() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        *client.floor_error.lock().unwrap() = Some("HTTP 404".into());
        let executor = executor(store);
        let result = executor.run(&client).await;
        assert!(!result.success);
        assert_eq!(client.book_calls.load(Ordering::SeqCst), 0);
        assert!(
            result.members[0].message.contains("房间或座位查询失败"),
            "实际：{}",
            result.members[0].message
        );
    }

    /// 实测：读 404 是瞬时并发保护（8 路并发打出 404 后立即串行 10 次全部 200），
    /// 与业务失败走同一个 POLL_MS，读路径不再有秒级的"常规节拍"。
    #[tokio::test]
    async fn busy_and_ordinary_failures_share_one_poll_interval() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let mut plan = plan();
        plan.fallback_seats.clear();
        store.save_plan(&plan).unwrap();
        let client = Fake::new();
        // 首轮 404（并发保护），次轮业务失败（时段未到），第三轮成功
        *client.floor_error_once.lock().unwrap() = Some("HTTP 404".into());
        client
            .responses
            .lock()
            .unwrap()
            .push_back(json!({"CODE": "error", "MESSAGE": "未到预约时间"}));
        let mut executor = BookingExecutor::with_sleep(store, Arc::new(|_ms| Box::pin(async {})));
        let polls = executor.record_polls();
        let result = executor.run_burst(&client, 60_000).await;
        assert!(result.success, "{}", result.message);
        let sleeps = polls.lock().unwrap().clone();
        assert_eq!(
            sleeps.as_slice(),
            [POLL_MS, POLL_MS],
            "404 与业务失败必须同间隔，实际 {sleeps:?}"
        );
        // 实测读路径零间隔 60 次全过，故轮询间隔不该被拉到秒级
        const { assert!(POLL_MS < 1_000, "读无速率限制，轮询间隔不该到秒级") };
    }

    /// 组合方案：每个成员各发一次预锁请求，不多不少。
    #[tokio::test]
    async fn prelock_covers_every_group_member_once() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let mut second = plan();
        second.id = "p2".into();
        second.seat_num = "102".into();
        second.start_hour = 20;
        second.duration_hours = 2;
        let mut first = plan();
        first.start_hour = 8;
        first.duration_hours = 4;
        store.save_plan(&first).unwrap();
        store.save_plan(&second).unwrap();
        let group = hdu_sniper_core::BookingGroup {
            id: "g1".into(),
            kind: hdu_sniper_core::PlanKind::Group,
            name: "晚自习".into(),
            member_plan_ids: vec!["p1".into(), "p2".into()],
            members: Some(vec![first, second]),
            weekdays: (1..=7).collect(),
            enabled: true,
            created_at: "2026-09-05T00:00:00.000Z".into(),
            updated_at: "2026-09-05T00:00:00.000Z".into(),
        };
        store.save_group(&group).unwrap();
        // 真实约束：启用组合时其余方案（含成员单方案）都被置为 disabled
        store.set_only_enabled("g1", true).unwrap();
        let client = Fake::new();
        let executor = executor(store);
        let result = executor.lock_once(&client).await;
        assert!(result.success, "{}", result.message);
        assert_eq!(
            client.floors_calls.load(Ordering::SeqCst),
            2,
            "每个成员各查一次座位图"
        );
        assert_eq!(
            client.lock_calls.load(Ordering::SeqCst),
            2,
            "每个成员各锁一次"
        );
        assert_eq!(result.locks.len(), 2);
        let seats: Vec<&str> = result.locks.iter().map(|l| l.seat_num.as_str()).collect();
        assert_eq!(seats, ["101", "102"], "两个成员的座位都要锁到");
    }

    /// 组合中某个成员失败：只记该成员的原因，其余成员照常各锁一次，
    /// 失败成员不重试、不换备选。
    #[tokio::test]
    async fn prelock_continues_after_one_member_fails() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let mut second = plan();
        second.id = "p2".into();
        second.seat_num = "102".into();
        second.start_hour = 20;
        second.duration_hours = 2;
        let mut first = plan();
        first.start_hour = 8;
        first.duration_hours = 4;
        store.save_plan(&first).unwrap();
        store.save_plan(&second).unwrap();
        let group = hdu_sniper_core::BookingGroup {
            id: "g1".into(),
            kind: hdu_sniper_core::PlanKind::Group,
            name: "晚自习".into(),
            member_plan_ids: vec!["p1".into(), "p2".into()],
            members: Some(vec![first, second]),
            weekdays: (1..=7).collect(),
            enabled: true,
            created_at: "2026-09-05T00:00:00.000Z".into(),
            updated_at: "2026-09-05T00:00:00.000Z".into(),
        };
        store.save_group(&group).unwrap();
        // 真实约束：启用组合时其余方案（含成员单方案）都被置为 disabled
        store.set_only_enabled("g1", true).unwrap();
        let client = Fake::new();
        // 第一个成员的座位被占：它失败，第二个成员仍应被锁
        client
            .seat_states
            .lock()
            .unwrap()
            .insert("101".into(), "1".into());
        let executor = executor(store);
        let result = executor.lock_once(&client).await;
        assert!(!result.success, "有成员失败就不算整体成功");
        assert_eq!(
            client.floors_calls.load(Ordering::SeqCst),
            2,
            "两个成员都查过"
        );
        assert_eq!(
            client.lock_calls.load(Ordering::SeqCst),
            1,
            "被占的成员不发锁座，也不重试"
        );
        assert_eq!(result.locks.len(), 1);
        assert_eq!(result.locks[0].seat_num, "102");
        assert!(
            result.message.contains("101") && result.message.contains("不重试"),
            "失败原因必须带座位号，实际：{}",
            result.message
        );
    }

    /// 单方案只有一个成员：仍然只发一次请求。
    #[tokio::test]
    async fn prelock_issues_one_request_for_a_single_plan() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        let executor = executor(store);
        let result = executor.lock_once(&client).await;
        assert!(result.success, "{}", result.message);
        assert_eq!(client.floors_calls.load(Ordering::SeqCst), 1);
        assert_eq!(client.lock_calls.load(Ordering::SeqCst), 1);
        assert_eq!(result.locks.len(), 1);
    }

    /// 预锁失败不重试、不换座位、不兜底：只发一次查询，零次锁座，写日志后结束。
    #[tokio::test]
    async fn prelock_failure_is_logged_without_retry() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        *client.floor_error.lock().unwrap() = Some("HTTP 404".into());
        let executor = executor(store.clone());
        let result = executor.lock_once(&client).await;
        assert!(!result.success);
        assert!(result.locks.is_empty());
        assert_eq!(
            client.lock_calls.load(Ordering::SeqCst),
            0,
            "查询失败不得发锁座"
        );
        assert!(
            result.message.contains("不重试"),
            "实际：{}",
            result.message
        );
        let logged = store.list_audit(20).unwrap().iter().any(|item| {
            item.event == "booking_prelock_finished"
                && item.payload.get("success").and_then(Value::as_bool) == Some(false)
        });
        assert!(logged, "失败必须落审计日志");
    }

    /// 座位已被占用时同样只请求一次：不发锁座，直接记日志结束。
    #[tokio::test]
    async fn prelock_skips_an_occupied_seat_without_retry() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        // 主座位与备选都被占：不回退到备选，也不重试
        {
            let mut states = client.seat_states.lock().unwrap();
            states.insert("101".into(), "1".into());
            states.insert("102".into(), "1".into());
        }
        let executor = executor(store);
        let result = executor.lock_once(&client).await;
        assert!(!result.success);
        assert_eq!(client.floors_calls.load(Ordering::SeqCst), 1);
        assert_eq!(client.lock_calls.load(Ordering::SeqCst), 0);
    }

    /// 20:00 拥堵（404 持续）期间写入槽不得累积欠账，
    /// 否则恢复瞬间会连发提交，而实测写入 3 次即封号 10 分钟。
    #[tokio::test]
    async fn busy_period_does_not_bank_write_credits() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let mut plan = plan();
        plan.fallback_seats.clear();
        store.save_plan(&plan).unwrap();
        let client = Fake::new();
        *client.floor_error_once.lock().unwrap() = Some("HTTP 404".into());
        let mut executor = BookingExecutor::with_sleep(store, Arc::new(|_ms| Box::pin(async {})));
        // 把写入槽推得很旧，模拟拥堵前已攒下大量欠账
        *executor.write_slot.lock().unwrap() = Instant::now() - Duration::from_secs(300);
        let _polls = executor.record_polls();
        let result = executor.run_burst(&client, 60_000).await;
        assert!(result.success, "{}", result.message);
        // 拥堵轮结束后写入槽应被顶到"现在"附近，而不是仍停留在 300s 前
        let slot = *executor.write_slot.lock().unwrap();
        assert!(
            slot >= Instant::now() - Duration::from_secs(1),
            "拥堵期间应重置写入槽，避免恢复瞬间连发"
        );
    }

    /// 只有写入需要节拍：实测写入 10s 可持续；读路径无速率限制，不设节拍。
    #[test]
    fn only_writes_are_paced() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let executor = BookingExecutor::with_sleep(store, Arc::new(|_ms| Box::pin(async {})));
        assert_eq!(executor.write_interval_ms.load(Ordering::Relaxed), 10_000);
    }

    /// 读请求之间不得有任何人为等待：实测零间隔背靠背 60 次全部 200。
    /// 用记录睡眠时长的 sleep 桩，断言读路径一次都不睡。
    #[tokio::test]
    async fn reads_are_not_throttled_at_all() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        let slept: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = slept.clone();
        let executor = BookingExecutor::with_sleep(
            store,
            Arc::new(move |ms| {
                let sink = sink.clone();
                Box::pin(async move {
                    sink.lock().unwrap().push(ms);
                })
            }),
        );
        // 预锁：一次查询 + 一次锁座，两者都不该触发睡眠
        let lock = executor.lock_once(&client).await;
        assert!(lock.success, "{}", lock.message);
        assert!(
            slept.lock().unwrap().is_empty(),
            "预锁读写各一次，不应有任何节拍等待，实际 {:?}",
            slept.lock().unwrap()
        );
    }

    /// 实测：预锁与正式预约共用同一写入额度。命中封禁时每个成员仍各发**一次**
    /// 请求（不重试、不提前中断），失败原因逐条记进日志。
    #[tokio::test]
    async fn prelock_logs_the_ban_without_retrying() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let mut second = plan();
        second.id = "p2".into();
        second.seat_num = "102".into();
        second.start_hour = 20;
        second.duration_hours = 2;
        let mut first = plan();
        first.start_hour = 8;
        first.duration_hours = 4;
        // 组成员受外键约束，必须先各自落库
        store.save_plan(&first).unwrap();
        store.save_plan(&second).unwrap();
        let group = hdu_sniper_core::BookingGroup {
            id: "g1".into(),
            kind: hdu_sniper_core::PlanKind::Group,
            name: "晚自习".into(),
            member_plan_ids: vec!["p1".into(), "p2".into()],
            members: Some(vec![first, second]),
            weekdays: (1..=7).collect(),
            enabled: true,
            created_at: "2026-09-05T00:00:00.000Z".into(),
            updated_at: "2026-09-05T00:00:00.000Z".into(),
        };
        store.save_group(&group).unwrap();
        // 真实约束：启用组合时其余方案（含成员单方案）都被置为 disabled
        store.set_only_enabled("g1", true).unwrap();
        let client = Fake::new();
        *client.lock_message.lock().unwrap() = Some("请求过于频繁，请10分钟后再试".into());
        let executor = executor(store);
        let result = executor.lock_once(&client).await;
        assert!(!result.success);
        assert!(result.locks.is_empty(), "封禁下不得存任何座位提示");
        assert_eq!(
            client.lock_calls.load(Ordering::SeqCst),
            2,
            "每个成员各一次，失败也不重试"
        );
        assert!(
            result.message.contains("请求过于频繁"),
            "封禁文案必须进日志，实际：{}",
            result.message
        );
    }
}
