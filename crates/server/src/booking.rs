#![allow(async_fn_in_trait)]

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Datelike, TimeZone, Utc};
use chrono_tz::Asia::Shanghai;
use hdu_sniper_core::{booking_day_offset_for, BookingPlan, PlanListItem};
use hdu_sniper_hdu::{HduError, LibraryClient};
use hdu_sniper_store::Store;
use serde_json::Value;

type SleepFn = Arc<dyn Fn(u64) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

const DEFAULT_INTERVAL_MS: u64 = 4_000;
const MAX_BACKOFF_MS: u64 = 5 * 60_000;
const THROTTLE_MS: u64 = 15_000;
pub const ACCOUNT_BAN_MS: u64 = 10 * 60_000;

pub trait BookingClient: Send + Sync {
    async fn bookings(&self) -> Result<Vec<Value>, HduError>;
    async fn floors(
        &self,
        room_query: &str,
        lookup_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Vec<Value>, HduError>;
    async fn book_seat(
        &self,
        seat_id: &str,
        begin_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Value, HduError>;
    async fn lock_seat(
        &self,
        seat_id: &str,
        begin_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Value, HduError>;
    async fn unlock_all_seats(&self) -> Result<Value, HduError>;
}

impl BookingClient for LibraryClient {
    async fn bookings(&self) -> Result<Vec<Value>, HduError> {
        LibraryClient::bookings(self).await
    }
    async fn floors(
        &self,
        room_query: &str,
        lookup_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Vec<Value>, HduError> {
        LibraryClient::floors(self, room_query, lookup_time, duration_hours).await
    }
    async fn book_seat(
        &self,
        seat_id: &str,
        begin_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Value, HduError> {
        LibraryClient::book_seat(self, seat_id, begin_time, duration_hours).await
    }
    async fn lock_seat(
        &self,
        seat_id: &str,
        begin_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Value, HduError> {
        LibraryClient::lock_seat(self, seat_id, begin_time, duration_hours).await
    }
    async fn unlock_all_seats(&self) -> Result<Value, HduError> {
        LibraryClient::unlock_all_seats(self).await
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingMemberResult {
    pub plan_id: String,
    pub seat_num: Option<String>,
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub terminal: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unverified: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub blocked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

impl BookingMemberResult {
    fn failure(plan: &BookingPlan, seat_num: Option<String>, message: impl Into<String>) -> Self {
        Self {
            plan_id: plan.id.clone(),
            seat_num,
            success: false,
            message: message.into(),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingRunResult {
    pub plan_id: Option<String>,
    pub kind: Option<String>,
    pub success: bool,
    pub message: String,
    pub members: Vec<BookingMemberResult>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingLock {
    pub plan_id: String,
    pub seat_id: String,
    pub seat_num: String,
    pub begin_seconds: i64,
    pub duration_hours: i64,
    pub locked: bool,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingLockResult {
    pub plan_id: Option<String>,
    pub kind: Option<String>,
    pub success: bool,
    pub message: String,
    pub locks: Vec<BookingLock>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub terminal: bool,
}

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

    pub async fn run<C: BookingClient>(&self, client: &C) -> BookingRunResult {
        self.abort_prelock();
        let result = self.run_attempt(client, false, None).await;
        let _ = self.store.write_audit(
            "booking_run_finished",
            &serde_json::json!({
                "planId": result.plan_id,
                "kind": result.kind,
                "success": result.success,
                "members": result.members.len(),
                "message": result.message,
            }),
        );
        result
    }

    pub async fn run_burst<C: BookingClient>(
        &self,
        client: &C,
        interval_ms: u64,
        timeout_ms: u64,
    ) -> BookingRunResult {
        self.set_interval_ms(interval_ms);
        self.abort_prelock();
        let started = Instant::now();
        let deadline = started + Duration::from_millis(timeout_ms);
        let mut finished: Vec<BookingMemberResult> = Vec::new();
        let mut unverified: std::collections::HashMap<String, u8> =
            std::collections::HashMap::new();
        let mut backoff = interval_ms.max(1);
        let mut first_attempt = true;
        loop {
            let result = self
                .run_attempt(client, false, Some((&mut finished, first_attempt)))
                .await;
            first_attempt = false;
            if let Some(blocked) = result.members.iter().find(|member| member.blocked) {
                return BookingRunResult {
                    success: false,
                    message: blocked.message.clone(),
                    ..result
                };
            }
            for member in &result.members {
                if (member.success || member.terminal)
                    && !finished.iter().any(|item| item.plan_id == member.plan_id)
                {
                    finished.push(member.clone());
                }
                if member.terminal {
                    if !finished.iter().any(|item| item.plan_id == member.plan_id) {
                        finished.push(member.clone());
                    }
                } else if member.unverified {
                    let count = unverified.entry(member.plan_id.clone()).or_insert(0);
                    *count += 1;
                    if *count >= 3 && !finished.iter().any(|item| item.plan_id == member.plan_id) {
                        let mut terminal = member.clone();
                        terminal.terminal = true;
                        terminal.message = format!("{}（多次未能确认，停止重试）", member.message);
                        finished.push(terminal);
                    }
                }
            }
            let pending = result.members.is_empty()
                || result
                    .members
                    .iter()
                    .any(|member| !member.success && !member.terminal);
            if result.success || !pending || Instant::now() >= deadline {
                let _ = self.store.write_audit(
                    "booking_run_finished",
                    &serde_json::json!({
                        "planId": result.plan_id,
                        "kind": result.kind,
                        "success": result.success,
                        "members": result.members.len(),
                        "message": result.message,
                    }),
                );
                return result;
            }
            let retry_after = result
                .members
                .iter()
                .filter_map(|member| member.retry_after_ms)
                .max()
                .unwrap_or(0);
            backoff = retry_after.max(next_backoff_ms(backoff, interval_ms.max(1), MAX_BACKOFF_MS));
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .as_millis() as u64;
            self.sleep_ms(backoff.min(remaining)).await;
        }
    }

    async fn run_attempt<C: BookingClient>(
        &self,
        client: &C,
        dry_run: bool,
        finished: Option<(&mut Vec<BookingMemberResult>, bool)>,
    ) -> BookingRunResult {
        let enabled = self
            .store
            .list_plan_items()
            .ok()
            .and_then(|items| items.into_iter().find(|item| is_enabled(item)));
        let Some(enabled) = enabled else {
            return BookingRunResult {
                success: false,
                message: "没有启用的预约方案".into(),
                ..BookingRunResult::default()
            };
        };
        let (plan_id, kind, members) = plan_members(&enabled);
        let booked = self.booked_begin_times(client, &mut Vec::new()).await;
        let now = Utc::now();
        let mut results = Vec::new();
        let finished_map: std::collections::HashMap<String, BookingMemberResult> = finished
            .map(|(items, _)| {
                items
                    .iter()
                    .cloned()
                    .map(|item| (item.plan_id.clone(), item))
                    .collect()
            })
            .unwrap_or_default();
        for plan in members {
            if let Some(settled) = finished_map.get(&plan.id) {
                results.push(settled.clone());
                continue;
            }
            let Some(begin) = member_begin(&plan, now) else {
                continue;
            };
            let begin_seconds = begin.timestamp();
            let result = if booked
                .as_ref()
                .is_some_and(|set| set.contains(&begin_seconds))
            {
                BookingMemberResult {
                    plan_id: plan.id.clone(),
                    seat_num: Some(plan.seat_num.clone()),
                    success: true,
                    message: "该时段已有预约，跳过重复提交".into(),
                    ..BookingMemberResult::default()
                }
            } else {
                self.execute_plan(client, &plan, begin, dry_run, None, None, booked.as_ref())
                    .await
            };
            let _ = self.store.write_audit(
                "booking_member_finished",
                &serde_json::json!({
                    "planId": plan.id,
                    "success": result.success,
                    "seatNum": result.seat_num,
                    "message": result.message,
                }),
            );
            results.push(result);
        }
        let success = !results.is_empty() && results.iter().all(|item| item.success);
        let message = if dry_run {
            "预约预演完成，未提交预约请求".to_string()
        } else if success {
            "预约任务完成".to_string()
        } else {
            format!(
                "预约失败：{}",
                results
                    .iter()
                    .map(|item| item.message.clone())
                    .collect::<Vec<_>>()
                    .join("；")
            )
        };
        BookingRunResult {
            plan_id: Some(plan_id),
            kind: Some(kind),
            success,
            message,
            members: results,
        }
    }

    async fn execute_plan<C: BookingClient>(
        &self,
        client: &C,
        plan: &BookingPlan,
        begin: DateTime<Utc>,
        dry_run: bool,
        preferred: Option<&BookingLock>,
        skip_seat: Option<&str>,
        snapshot: Option<&std::collections::HashSet<i64>>,
    ) -> BookingMemberResult {
        let candidates: Vec<String> = if let Some(preferred) = preferred {
            vec![preferred.seat_num.clone()]
        } else {
            std::iter::once(plan.seat_num.clone())
                .chain(plan.fallback_seats.iter().cloned())
                .filter(|seat| skip_seat != Some(seat.as_str()))
                .collect()
        };
        let mut last = BookingMemberResult::failure(plan, None, "未找到可用座位");
        for seat_num in candidates {
            let floors = match self
                .paced(|| client.floors(&plan.room_query, begin, plan.duration_hours))
                .await
            {
                Ok(floors) => floors,
                Err(error) => {
                    last = BookingMemberResult::failure(
                        plan,
                        Some(seat_num),
                        format!("房间或座位查询失败: {error}"),
                    );
                    continue;
                }
            };
            let seat_id = preferred
                .filter(|lock| lock.seat_num == seat_num)
                .map(|lock| lock.seat_id.clone())
                .or_else(|| seat_id_from_floors(&floors, plan, &seat_num));
            let Some(seat_id) = seat_id else {
                last = BookingMemberResult::failure(
                    plan,
                    Some(seat_num.clone()),
                    format!("找不到座位 {seat_num}"),
                );
                continue;
            };
            if dry_run {
                return BookingMemberResult {
                    plan_id: plan.id.clone(),
                    seat_num: Some(seat_num),
                    success: true,
                    message: "预演成功，未提交预约请求".into(),
                    ..BookingMemberResult::default()
                };
            }
            let response = match self
                .paced(|| client.book_seat(&seat_id, begin, plan.duration_hours))
                .await
            {
                Ok(response) => response,
                Err(error) => {
                    let result = self
                        .booking_failure(client, plan, begin, &seat_num, error, snapshot)
                        .await;
                    if result.success || result.terminal || result.unverified {
                        return result;
                    }
                    last = result;
                    continue;
                }
            };
            let result = self
                .finalize_booking(client, plan, begin, &seat_num, response, snapshot)
                .await;
            if result.success || result.terminal || result.unverified {
                return result;
            }
            last = result;
        }
        last
    }

    async fn booking_failure<C: BookingClient>(
        &self,
        client: &C,
        plan: &BookingPlan,
        begin: DateTime<Utc>,
        seat_num: &str,
        error: HduError,
        snapshot: Option<&std::collections::HashSet<i64>>,
    ) -> BookingMemberResult {
        if matches!(error, HduError::AuthenticationExpired(_)) {
            return BookingMemberResult::failure(plan, Some(seat_num.into()), error.to_string());
        }
        if matches!(error, HduError::RequestTimeout) {
            match self.confirm_booking(client, begin, snapshot).await {
                Confirm::Found(Some(item)) => {
                    return BookingMemberResult {
                        plan_id: plan.id.clone(),
                        seat_num: Some(
                            item.get("seatNum")
                                .map(value_to_string)
                                .filter(|value| !value.is_empty())
                                .unwrap_or_else(|| seat_num.into()),
                        ),
                        success: true,
                        message: "预约已生效（响应超时，以预约列表为准）".into(),
                        ..BookingMemberResult::default()
                    };
                }
                Confirm::Unknown => {
                    return BookingMemberResult {
                        unverified: true,
                        message: "请求超时，且预约列表暂不可用，结果未确认".into(),
                        ..BookingMemberResult::failure(plan, Some(seat_num.into()), "")
                    };
                }
                _ => {
                    return BookingMemberResult {
                        unverified: true,
                        message: "请求超时，预约列表尚未显示该预约，结果未确认".into(),
                        ..BookingMemberResult::failure(plan, Some(seat_num.into()), "")
                    };
                }
            }
        }
        BookingMemberResult::failure(plan, Some(seat_num.into()), error.to_string())
    }

    async fn finalize_booking<C: BookingClient>(
        &self,
        client: &C,
        plan: &BookingPlan,
        begin: DateTime<Utc>,
        seat_num: &str,
        response: Value,
        snapshot: Option<&std::collections::HashSet<i64>>,
    ) -> BookingMemberResult {
        if booking_succeeded(&response) {
            return BookingMemberResult {
                plan_id: plan.id.clone(),
                seat_num: Some(seat_num.into()),
                success: true,
                message: "预约成功".into(),
                ..BookingMemberResult::default()
            };
        }
        let message = response_message(&response);
        match classify_booking_failure(&message) {
            Some("ban") => BookingMemberResult {
                terminal: true,
                blocked: true,
                message: format!(
                    "账号已被馆方限流，需等待 {} 分钟：{message}",
                    ACCOUNT_BAN_MS / 60_000
                ),
                ..BookingMemberResult::failure(plan, Some(seat_num.into()), "")
            },
            Some("throttle") => BookingMemberResult {
                retry_after_ms: Some(THROTTLE_MS),
                ..BookingMemberResult::failure(plan, Some(seat_num.into()), message)
            },
            Some("flow") => BookingMemberResult {
                retry_after_ms: Some(DEFAULT_INTERVAL_MS),
                ..BookingMemberResult::failure(plan, Some(seat_num.into()), message)
            },
            _ => match self.confirm_booking(client, begin, snapshot).await {
                Confirm::Found(Some(item)) => BookingMemberResult {
                    plan_id: plan.id.clone(),
                    seat_num: Some(
                        item.get("seatNum")
                            .map(value_to_string)
                            .filter(|value| !value.is_empty())
                            .unwrap_or_else(|| seat_num.into()),
                    ),
                    success: true,
                    message: "预约已生效（以预约列表为准）".into(),
                    ..BookingMemberResult::default()
                },
                Confirm::Unknown => BookingMemberResult {
                    unverified: true,
                    message: format!("预约结果未确认（预约列表暂不可用）：{message}"),
                    ..BookingMemberResult::failure(plan, Some(seat_num.into()), "")
                },
                _ if is_duplicate_message(&message) => BookingMemberResult {
                    terminal: true,
                    message: format!("存在时间冲突的预约，请先取消后再试：{message}"),
                    ..BookingMemberResult::failure(plan, Some(seat_num.into()), "")
                },
                _ => BookingMemberResult::failure(plan, Some(seat_num.into()), message),
            },
        }
    }

    async fn confirm_booking<C: BookingClient>(
        &self,
        client: &C,
        begin: DateTime<Utc>,
        snapshot: Option<&std::collections::HashSet<i64>>,
    ) -> Confirm {
        let target = begin.timestamp();
        for attempt in 0..2 {
            match self.paced(|| client.bookings()).await {
                Ok(items) => {
                    let found = items
                        .iter()
                        .find(|item| item.get("time").map(value_to_i64) == Some(target))
                        .cloned();
                    return if found.is_some() {
                        Confirm::Found(found)
                    } else {
                        Confirm::Absent
                    };
                }
                Err(HduError::AuthenticationExpired(_)) => return Confirm::Unknown,
                Err(_) if attempt == 0 => {
                    self.sleep_ms(400).await;
                }
                Err(_) => break,
            }
        }
        if snapshot.is_some_and(|set| set.contains(&target)) {
            Confirm::Found(Some(serde_json::json!({"time": target})))
        } else {
            Confirm::Unknown
        }
    }

    async fn booked_begin_times<C: BookingClient>(
        &self,
        client: &C,
        finished: &mut Vec<BookingMemberResult>,
    ) -> Option<std::collections::HashSet<i64>> {
        let _ = finished;
        match self.paced(|| client.bookings()).await {
            Ok(items) => Some(
                items
                    .iter()
                    .map(|item| item.get("time").map(value_to_i64).unwrap_or(0))
                    .collect(),
            ),
            Err(_) => None,
        }
    }

    pub async fn lock_burst<C: BookingClient>(
        &self,
        client: &C,
        deadline_ms: u64,
    ) -> BookingLockResult {
        let Some(enabled) = self
            .store
            .list_plan_items()
            .ok()
            .and_then(|items| items.into_iter().find(|item| is_enabled(item)))
        else {
            return BookingLockResult {
                success: false,
                message: "没有启用的预约方案".into(),
                ..BookingLockResult::default()
            };
        };
        let (plan_id, kind, members) = plan_members(&enabled);
        let now = Utc::now();
        let deadline = Instant::now() + Duration::from_millis(deadline_ms);
        let booked = self
            .booked_begin_times(client, &mut Vec::new())
            .await
            .unwrap_or_default();
        let mut locks = Vec::new();
        self.prelock_aborted.store(false, Ordering::Relaxed);
        for plan in members {
            if self.prelock_aborted.load(Ordering::Relaxed) || Instant::now() >= deadline {
                break;
            }
            let Some(begin) = member_begin(&plan, now) else {
                continue;
            };
            let begin_seconds = begin.timestamp();
            if booked.contains(&begin_seconds) {
                continue;
            }
            let floors = match self
                .paced(|| client.floors(&plan.room_query, begin, plan.duration_hours))
                .await
            {
                Ok(floors) => floors,
                Err(_) => continue,
            };
            let seat_num = std::iter::once(plan.seat_num.clone())
                .chain(plan.fallback_seats.iter().cloned())
                .find(|seat| seat_id_from_floors(&floors, &plan, seat).is_some());
            let Some(seat_num) = seat_num else {
                continue;
            };
            let Some(seat_id) = seat_id_from_floors(&floors, &plan, &seat_num) else {
                continue;
            };
            let response = self
                .paced(|| client.lock_seat(&seat_id, begin, plan.duration_hours))
                .await;
            let locked = lock_succeeded(&response);
            locks.push(BookingLock {
                plan_id: plan.id.clone(),
                seat_id,
                seat_num,
                begin_seconds,
                duration_hours: plan.duration_hours,
                locked,
            });
        }
        let success = !locks.is_empty() && locks.iter().all(|lock| lock.locked);
        let message = if success {
            "座位预锁成功".into()
        } else {
            "预锁未完成，不影响正式预约".into()
        };
        let _ = self.store.write_audit(
            "booking_prelock_finished",
            &serde_json::json!({"planId": plan_id, "kind": kind, "success": success, "locks": locks.len(), "message": message}),
        );
        BookingLockResult {
            plan_id: Some(plan_id),
            kind: Some(kind),
            success,
            message,
            locks,
            terminal: false,
        }
    }
}

enum Confirm {
    Found(Option<Value>),
    Absent,
    Unknown,
}

fn is_enabled(item: &PlanListItem) -> bool {
    match item {
        PlanListItem::Single(plan) => plan.enabled,
        PlanListItem::Group(group) => group.enabled,
    }
}

fn plan_members(item: &PlanListItem) -> (String, String, Vec<BookingPlan>) {
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

fn next_backoff_ms(current: u64, base: u64, max: u64) -> u64 {
    let current = if current > 0 { current } else { base };
    (current * 2).max(base).min(max)
}

fn seat_id_from_floors(floors: &[Value], plan: &BookingPlan, seat_num: &str) -> Option<String> {
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

fn response_message(response: &Value) -> String {
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

fn booking_succeeded(response: &Value) -> bool {
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

fn lock_succeeded(response: &Result<Value, HduError>) -> bool {
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

fn classify_booking_failure(message: &str) -> Option<&'static str> {
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

fn is_duplicate_message(message: &str) -> bool {
    message.contains("已有预约") || message.contains("请勿重复") || message.contains("重复预约")
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

fn value_to_i64(value: &Value) -> i64 {
    match value {
        Value::Number(number) => number.as_i64().unwrap_or(0),
        Value::String(text) => text.parse().unwrap_or(0),
        _ => 0,
    }
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
