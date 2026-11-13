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

/// 读取路径（座位图 / 预约列表）的固定轮询间隔。
/// 实测 2026-11-13：searchSeats 以 1.1s 连续 40 次零限流，故读取按 1.1s 轮询。
const READ_POLL_MS: u64 = 1_100;
/// 写入路径（lockSeats / bookSeats）的最小间隔，实测确定，见 docs/HUITU-LIMITS.md。
/// 实测 2026-11-13：1.1s 连打第 2 次 throttle、第 3 次封号 10 分钟；
/// 3s 在刚打过一轮后第 2 次即封号；5s 首轮 8 次通过，但紧接的第二轮第 6 次封号。
/// 写入额度是累积桶而非单次间隔判定，5s 不可持续；10s 在多轮共 7 次写入中未被限流。
const WRITE_INTERVAL_MS: u64 = 10_000;
pub const ACCOUNT_BAN_MS: u64 = 10 * 60_000;

/// 预约执行器：查询座位、锁座、提交并判定结果。
pub struct BookingExecutor {
    store: Arc<Store>,
    read_interval_ms: AtomicU64,
    write_interval_ms: AtomicU64,
    read_slot: Mutex<Instant>,
    write_slot: Mutex<Instant>,
    sleep: SleepFn,
    prelock_aborted: AtomicBool,
    /// 19:59 预锁结果，由 20:00 的正式预约消费。
    locked_seats: Mutex<Vec<BookingLock>>,
    /// 预锁时读到的已预约时段快照，供开窗首轮免查列表使用。
    booked_snapshot: Mutex<Option<std::collections::HashSet<i64>>>,
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
            read_interval_ms: AtomicU64::new(READ_POLL_MS),
            write_interval_ms: AtomicU64::new(WRITE_INTERVAL_MS),
            read_slot: Mutex::new(Instant::now()),
            write_slot: Mutex::new(Instant::now()),
            sleep,
            prelock_aborted: AtomicBool::new(false),
            locked_seats: Mutex::new(Vec::new()),
            booked_snapshot: Mutex::new(None),
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

    /// 测试用：同时关闭读写节拍。
    pub fn set_interval_ms(&self, interval_ms: u64) {
        self.read_interval_ms.store(interval_ms, Ordering::Relaxed);
        self.write_interval_ms.store(interval_ms, Ordering::Relaxed);
    }

    pub fn set_write_interval_ms(&self, interval_ms: u64) {
        self.write_interval_ms.store(interval_ms, Ordering::Relaxed);
    }

    pub fn abort_prelock(&self) {
        self.prelock_aborted.store(true, Ordering::Relaxed);
    }

    async fn sleep_ms(&self, ms: u64) {
        (self.sleep)(ms).await;
    }

    async fn paced_with<F, Fut, T>(
        &self,
        slot: &Mutex<Instant>,
        interval_ms: &AtomicU64,
        f: F,
    ) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let now = Instant::now();
        let interval = Duration::from_millis(interval_ms.load(Ordering::Relaxed));
        let wait = {
            let mut slot = slot.lock().expect("pacing slot poisoned");
            let target = (*slot).max(now);
            *slot = target + interval;
            target.saturating_duration_since(now)
        };
        if !wait.is_zero() {
            self.sleep_ms(wait.as_millis() as u64).await;
        }
        f().await
    }

    /// 只读请求节拍（座位图、预约列表）。
    async fn paced<F, Fut, T>(&self, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        self.paced_with(&self.read_slot, &self.read_interval_ms, f).await
    }

    /// 写入请求节拍（锁座、提交预约），与读取分开计数。
    async fn paced_write<F, Fut, T>(&self, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        self.paced_with(&self.write_slot, &self.write_interval_ms, f).await
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
                return Err(HduError::Library(error));
            }
            self.floors_calls.fetch_add(1, Ordering::SeqCst);
            let states = self.seat_states.lock().unwrap();
            let state_of = |title: &str| {
                states.get(title).cloned().unwrap_or_else(|| "0".into())
            };
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
    /// 只有 DATA.result=fail 能区分，不得据此认为预锁成功。
    #[tokio::test]
    async fn lock_with_result_fail_is_not_a_success() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        *client.lock_result.lock().unwrap() = "fail".into();
        let executor = executor(store.clone());
        let result = executor.lock_burst(&client, 90_000).await;
        assert!(!result.success, "result=fail 不能算预锁成功");
        assert_eq!(result.locks.len(), 1);
        assert!(!result.locks[0].locked);
    }

    /// 预锁必须被正式预约消费：20:00 直接提交锁到的座位，不再重新解析座位号。
    #[tokio::test]
    async fn prelock_is_consumed_by_the_booking_burst() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let mut plan = plan();
        plan.seat_num = "102".into(); // 锁定备选座位，便于区分是否真的用了预锁
        plan.fallback_seats = vec!["101".into()];
        store.save_plan(&plan).unwrap();
        let client = Fake::new();
        let executor = executor(store);
        let lock = executor.lock_burst(&client, 90_000).await;
        assert!(lock.success, "{}", lock.message);
        let floors_before = client.floors_calls.load(Ordering::SeqCst);

        let result = executor.run_burst(&client, 0, 5_000).await;
        assert!(result.success, "{}", result.message);
        assert_eq!(result.members[0].seat_num.as_deref(), Some("102"));
        assert_eq!(
            client.booked_seats.lock().unwrap().as_slice(),
            ["seat-2"],
            "应提交预锁锁定的座位"
        );
        // 开窗首轮用预锁快照，不再查预约列表；座位图仍需查询以满足馆方流程校验
        assert!(client.floors_calls.load(Ordering::SeqCst) > floors_before);
    }

    /// 预锁失效（座位被占）时必须丢锁并按备选重试，不能死磕同一座位。
    #[tokio::test]
    async fn drops_a_stale_prelock_and_retries_another_seat() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        let executor = executor(store);
        let lock = executor.lock_burst(&client, 90_000).await;
        assert!(lock.success);
        assert_eq!(lock.locks[0].seat_num, "101");
        // 预锁后该座位被别人占走
        client
            .seat_states
            .lock()
            .unwrap()
            .insert("101".into(), "1".into());
        let result = executor.run_burst(&client, 0, 5_000).await;
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
        let mut executor =
            BookingExecutor::with_sleep(store, Arc::new(|_ms| Box::pin(async {})));
        let polls = executor.record_polls();
        // interval=0 → 轮询睡眠恒为 1ms；旧指数退避会得到 1,2,4
        let result = executor.run_burst(&client, 0, 60_000).await;
        assert!(result.success, "{}", result.message);
        assert_eq!(client.book_calls.load(Ordering::SeqCst), 4);
        let sleeps = polls.lock().unwrap().clone();
        assert_eq!(sleeps, vec![1, 1, 1], "轮询间隔必须恒定，实际 {sleeps:?}");
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
        let mut executor =
            BookingExecutor::with_sleep(store, Arc::new(|_ms| Box::pin(async {})));
        let polls = executor.record_polls();
        let result = executor.run_burst(&client, 0, 60_000).await;
        assert!(result.success, "{}", result.message);
        // 旧实现把 throttle 抬到 15s；现在应与其他失败一样恒定
        assert_eq!(polls.lock().unwrap().as_slice(), [1]);
    }

    /// 实测：提交前不强制重查座位图。故座位图查询失败（如网关 404）时，
    /// 若已有预锁座位提示，仍应直接提交，而不是整轮放弃。
    #[tokio::test]
    async fn submits_the_prelocked_seat_when_the_seat_map_query_fails() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        store.save_plan(&plan()).unwrap();
        let client = Fake::new();
        let executor = executor(store);
        let lock = executor.lock_burst(&client, 90_000).await;
        assert!(lock.success, "{}", lock.message);
        // 预锁之后座位图接口挂掉（issue #4 里的连续 HTTP 404）
        *client.floor_error.lock().unwrap() = Some("HTTP 404".into());
        let result = executor.run_burst(&client, 0, 5_000).await;
        assert!(result.success, "{}", result.message);
        assert_eq!(
            client.booked_seats.lock().unwrap().as_slice(),
            ["seat-1"],
            "查询失败时应提交预锁已知的 seatId"
        );
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

    /// 读写分离节拍默认值：读取 1.1s（实测 40 次零限流），写入 10s（实测可持续）。
    #[test]
    fn read_and_write_cadences_are_separate() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let executor = BookingExecutor::with_sleep(store, Arc::new(|_ms| Box::pin(async {})));
        assert_eq!(executor.read_interval_ms.load(Ordering::Relaxed), 1_100);
        assert_eq!(executor.write_interval_ms.load(Ordering::Relaxed), 10_000);
    }

    /// 实测：预锁与正式预约共用同一写入额度。预锁阶段命中封禁必须立刻停手，
    /// 不能继续为后续成员刷锁座请求，否则 20:00 的额度会被一起打没。
    #[tokio::test]
    async fn prelock_stops_immediately_on_account_ban() {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let mut second = plan();
        second.id = "p2".into();
        second.start_hour = 9;
        // 组成员受外键约束，必须先各自落库
        store.save_plan(&plan()).unwrap();
        store.save_plan(&second).unwrap();
        let group = hdu_sniper_core::BookingGroup {
            id: "g1".into(),
            kind: hdu_sniper_core::PlanKind::Group,
            name: "晚自习".into(),
            member_plan_ids: vec!["p1".into(), "p2".into()],
            members: Some(vec![plan(), second]),
            weekdays: (1..=7).collect(),
            enabled: true,
            created_at: "2026-09-05T00:00:00.000Z".into(),
            updated_at: "2026-09-05T00:00:00.000Z".into(),
        };
        store.save_group(&group).unwrap();
        let client = Fake::new();
        *client.lock_message.lock().unwrap() =
            Some("请求过于频繁，请10分钟后再试".into());
        let executor = executor(store);
        let result = executor.lock_burst(&client, 90_000).await;
        assert!(!result.success);
        assert_eq!(
            client.lock_calls.load(Ordering::SeqCst),
            1,
            "命中封禁后不得继续为第二个成员锁座"
        );
    }
}
