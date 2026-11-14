use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use hdu_sniper_auth::AuthService;
use hdu_sniper_core::json::{format_iso, value_to_i64, value_to_string};
use hdu_sniper_core::{
    booking_anchor_delay_seconds, booking_prelock_delay_seconds, shanghai_seconds_of_day,
    CheckInPolling, RuntimeStatus, BOOKING_PRELOCK_LEAD_SECONDS,
};
use hdu_sniper_hdu::Action;
use hdu_sniper_store::Store;
use serde_json::Value;
use tokio::time::sleep;

use crate::booking::BookingExecutor;

const CHECKIN_OFFSET_MS: i64 = 60_000;
/// 签到是写入类接口，按实测的写入节拍固定轮询（见 docs/HUITU-LIMITS.md）。
const CHECKIN_WRITE_POLL_MS: i64 = 10_000;
const CHECKIN_AUTH_RETRY_MS: i64 = 10 * 60_000;
/// 实测：命中“请求过于频繁，请10分钟后再试”后需等满 10 分钟。
const CHECKIN_BAN_MS: i64 = 10 * 60_000;
/// 20:00 抢座成功后同步签到列表的瞬态重试间隔（覆盖约 2 分钟高峰 404 窗口）。
const SYNC_RETRY_DELAYS_MS: &[u64] = &[5_000, 10_000, 20_000, 30_000, 30_000, 30_000];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyncOutcome {
    Done,
    Retry,
}

#[derive(Debug, Clone)]
struct PendingCheckIn {
    booking_id: String,
    begin_ms: i64,
    deadline_ms: i64,
    attempts: u32,
    next_at: i64,
}

#[derive(Debug, Clone)]
struct StatusState {
    scheduler: String,
    state: String,
    last_run_at: Option<String>,
    last_message: Option<String>,
}

impl Default for StatusState {
    fn default() -> Self {
        Self {
            scheduler: "running".into(),
            state: "idle".into(),
            last_run_at: None,
            last_message: None,
        }
    }
}

/// 后台调度器：预约窗口、自动签到与状态广播。
pub struct Scheduler {
    store: Arc<Store>,
    auth: Arc<AuthService>,
    booking: Arc<BookingExecutor>,
    status: Mutex<StatusState>,
    pending: Mutex<HashMap<String, PendingCheckIn>>,
    running: AtomicBool,
}

impl Scheduler {
    pub fn new(store: Arc<Store>, auth: Arc<AuthService>, booking: Arc<BookingExecutor>) -> Self {
        Self {
            store,
            auth,
            booking,
            status: Mutex::new(StatusState::default()),
            pending: Mutex::new(HashMap::new()),
            running: AtomicBool::new(false),
        }
    }

    pub fn auto_check_in_enabled(&self) -> bool {
        self.store
            .get_meta("auto_checkin_enabled")
            .ok()
            .flatten()
            .as_deref()
            == Some("1")
    }

    pub fn consented_at(&self) -> Option<String> {
        self.store
            .get_meta("auto_checkin_consented_at")
            .ok()
            .flatten()
    }

    pub fn consent_version(&self) -> &'static str {
        "2026-08-02.1"
    }

    pub fn status(&self) -> RuntimeStatus {
        let status = self
            .status
            .lock()
            .expect("scheduler status poisoned")
            .clone();
        let next = self.next_check_in();
        RuntimeStatus {
            scheduler: status.scheduler,
            state: status.state,
            last_run_at: status.last_run_at,
            last_message: status.last_message,
            check_in_polling: Some(CheckInPolling {
                active: next.is_some(),
                next_poll_at: next.map(|(_, at)| format_iso(at)),
                last_poll_at: None,
            }),
        }
    }

    pub fn next_check_in(&self) -> Option<(String, i64)> {
        let pending = self.pending.lock().expect("check-in pending poisoned");
        pending
            .values()
            .min_by_key(|item| item.next_at)
            .map(|item| (item.booking_id.clone(), item.next_at))
    }

    pub fn set_auto_check_in(&self, enabled: bool, agreed: bool) {
        let _ = self
            .store
            .set_meta("auto_checkin_enabled", if enabled { "1" } else { "0" });
        if enabled && agreed {
            let _ = self.store.set_meta(
                "auto_checkin_consented_at",
                &Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            );
        }
        if !enabled {
            self.pending
                .lock()
                .expect("check-in pending poisoned")
                .clear();
        }
    }

    pub fn observe_bookings(&self, bookings: &[Value]) {
        self.observe_bookings_at(bookings, Utc::now());
    }

    pub fn observe_bookings_at(&self, bookings: &[Value], now: DateTime<Utc>) {
        if !self.auto_check_in_enabled() {
            self.pending
                .lock()
                .expect("check-in pending poisoned")
                .clear();
            return;
        }
        let now_ms = now.timestamp_millis();
        let mut pending = self.pending.lock().expect("check-in pending poisoned");
        let mut seen = std::collections::HashSet::new();
        for booking in bookings {
            let id = booking.get("id").map(value_to_string).unwrap_or_default();
            let begin_ms = booking.get("time").map(value_to_i64).unwrap_or(0) * 1000;
            let deadline_ms =
                begin_ms + booking.get("limitSignBack").map(value_to_i64).unwrap_or(0) * 1000;
            if id.is_empty() || begin_ms <= 0 || deadline_ms <= now_ms {
                continue;
            }
            if booking.get("status").map(value_to_string).as_deref() != Some("0") {
                continue;
            }
            seen.insert(id.clone());
            let sign_at = begin_ms + CHECKIN_OFFSET_MS;
            let next_at = sign_at.max(now_ms + 500);
            if let Some(item) = pending.get_mut(&id) {
                item.begin_ms = begin_ms;
                item.deadline_ms = deadline_ms;
                item.next_at = item.next_at.min(next_at);
            } else {
                pending.insert(
                    id.clone(),
                    PendingCheckIn {
                        booking_id: id,
                        begin_ms,
                        deadline_ms,
                        attempts: 0,
                        next_at,
                    },
                );
            }
        }
        pending.retain(|id, _| seen.contains(id));
    }

    pub fn note_checked_in(&self, booking_id: &str) {
        if self
            .pending
            .lock()
            .expect("check-in pending poisoned")
            .remove(booking_id)
            .is_some()
        {
            let _ = self.store.write_audit(
                "checkin_succeeded",
                &serde_json::json!({"bookingId": booking_id, "source": "manual"}),
            );
        }
    }

    pub fn forget(&self, booking_id: &str) {
        self.pending
            .lock()
            .expect("check-in pending poisoned")
            .remove(booking_id);
    }

    pub async fn sync_check_ins(&self) {
        self.sync_check_ins_with_delays(SYNC_RETRY_DELAYS_MS).await;
    }

    async fn sync_check_ins_with_delays(&self, retry_delays_ms: &[u64]) {
        if self
            .sync_check_ins_once(true, !retry_delays_ms.is_empty())
            .await
            == SyncOutcome::Done
        {
            return;
        }
        self.sync_check_ins_retries(retry_delays_ms).await;
    }

    async fn sync_check_ins_retries(&self, retry_delays_ms: &[u64]) {
        for (idx, delay_ms) in retry_delays_ms.iter().enumerate() {
            sleep(Duration::from_millis(*delay_ms)).await;
            let is_last = idx + 1 == retry_delays_ms.len();
            if self.sync_check_ins_once(is_last, !is_last).await == SyncOutcome::Done {
                return;
            }
        }
    }

    async fn sync_check_ins_once(&self, log_failure: bool, allow_retry: bool) -> SyncOutcome {
        if !self.auto_check_in_enabled() {
            self.pending
                .lock()
                .expect("check-in pending poisoned")
                .clear();
            return SyncOutcome::Done;
        }
        if !self.auth.authenticated() && !self.auth.restore().await {
            self.set_state("auth_required");
            return SyncOutcome::Done;
        }
        match self.auth.client.bookings().await {
            Ok(bookings) => {
                self.observe_bookings(&bookings);
                self.set_state("idle");
                self.touch_last_run_at();
                SyncOutcome::Done
            }
            Err(hdu_sniper_hdu::HduError::AuthenticationExpired(_)) => {
                if self.auth.restore().await {
                    if log_failure {
                        let _ = self.store.write_audit(
                            "checkin_sync_failed",
                            &serde_json::json!({
                                "error": "登录状态已刷新，等待重试",
                                "willRetry": allow_retry,
                            }),
                        );
                    }
                    if allow_retry {
                        SyncOutcome::Retry
                    } else {
                        SyncOutcome::Done
                    }
                } else {
                    self.set_state("auth_required");
                    if log_failure {
                        let _ = self.store.write_audit(
                            "checkin_sync_failed",
                            &serde_json::json!({"error": "登录状态已失效", "willRetry": false}),
                        );
                    }
                    SyncOutcome::Done
                }
            }
            Err(error) => {
                let retryable = is_retryable_sync_error(&error);
                let will_retry = allow_retry && retryable;
                if log_failure {
                    let _ = self.store.write_audit(
                        "checkin_sync_failed",
                        &serde_json::json!({"error": error.to_string(), "willRetry": will_retry}),
                    );
                }
                if will_retry {
                    SyncOutcome::Retry
                } else {
                    SyncOutcome::Done
                }
            }
        }
    }

    async fn sync_check_ins_after_booking(self: &Arc<Self>) {
        if self
            .sync_check_ins_once(true, !SYNC_RETRY_DELAYS_MS.is_empty())
            .await
            == SyncOutcome::Retry
        {
            let scheduler = self.clone();
            tokio::spawn(async move {
                scheduler.sync_check_ins_retries(SYNC_RETRY_DELAYS_MS).await;
            });
        }
    }

    pub async fn run_now(self: &Arc<Self>) -> serde_json::Value {
        if self.running.swap(true, Ordering::SeqCst) {
            return serde_json::json!({"success": false, "message": "已有任务正在运行"});
        }
        if !self.auth.authenticated() && !self.auth.restore().await {
            self.running.store(false, Ordering::SeqCst);
            self.set_state("auth_required");
            return serde_json::json!({"success": false, "message": "登录状态已失效，请重新登录"});
        }
        self.set_state("running");
        let result = self.booking.run(&self.auth.client).await;
        self.running.store(false, Ordering::SeqCst);
        self.set_message(result.message.clone());
        self.set_state("idle");
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
        if result.success {
            self.sync_check_ins_after_booking().await;
        }
        serde_json::json!({"success": result.success, "message": result.message})
    }

    pub async fn run(self: Arc<Self>) {
        let initial = self.clone();
        tokio::spawn(async move { initial.sync_check_ins().await });
        let booking = self.clone();
        tokio::spawn(async move { booking.booking_loop().await });
        let checkin = self.clone();
        tokio::spawn(async move { checkin.checkin_loop().await });
    }

    async fn booking_loop(self: Arc<Self>) {
        loop {
            if !self.has_enabled_plan() {
                sleep(Duration::from_secs(60)).await;
                continue;
            }
            let seconds = shanghai_seconds_of_day(Utc::now());
            let prelock = booking_prelock_delay_seconds(seconds, BOOKING_PRELOCK_LEAD_SECONDS);
            if prelock > 0 {
                sleep(Duration::from_secs(prelock as u64)).await;
                self.prelock_once().await;
            }
            let seconds = shanghai_seconds_of_day(Utc::now());
            let anchor = booking_anchor_delay_seconds(seconds);
            sleep(Duration::from_secs(anchor as u64)).await;
            if !self.has_enabled_plan() {
                continue;
            }
            if !self.auth.authenticated() && !self.auth.restore().await {
                self.set_state("auth_required");
                continue;
            }
            self.set_state("running");
            let result = self.booking.run_burst(&self.auth.client, 10 * 60_000).await;
            self.set_message(result.message);
            self.set_state("idle");
            if result.success {
                self.sync_check_ins_after_booking().await;
            }
        }
    }

    /// 19:59:00 预锁一次。失败不回退、不兜底，只记日志。
    /// 写请求超时 30s < 提前量 60s，故不会跨过 20:00 锚点。
    async fn prelock_once(&self) {
        if !self.has_enabled_plan() {
            return;
        }
        if !self.auth.authenticated() && !self.auth.restore().await {
            let _ = self.store.write_audit(
                "booking_prelock_skipped",
                &serde_json::json!({"reason": "登录态失效"}),
            );
            return;
        }
        let result = self.booking.lock_once(&self.auth.client).await;
        self.set_message(result.message);
    }

    async fn checkin_loop(&self) {
        loop {
            if !self.auto_check_in_enabled() {
                sleep(Duration::from_secs(30)).await;
                continue;
            }
            let next = self.next_check_in();
            let Some((_, next_at)) = next else {
                sleep(Duration::from_secs(300)).await;
                continue;
            };
            let now = Utc::now().timestamp_millis();
            let delay = (next_at - now).max(250) as u64;
            sleep(Duration::from_millis(delay)).await;
            self.checkin_tick().await;
        }
    }

    async fn checkin_tick(&self) {
        if !self.auto_check_in_enabled() {
            self.pending
                .lock()
                .expect("check-in pending poisoned")
                .clear();
            return;
        }
        let now = Utc::now().timestamp_millis();
        let due: Vec<PendingCheckIn> = {
            let pending = self.pending.lock().expect("check-in pending poisoned");
            pending
                .values()
                .filter(|item| item.next_at <= now)
                .cloned()
                .collect()
        };
        if due.is_empty() {
            return;
        }
        if !self.auth.authenticated() && !self.auth.restore().await {
            for item in due {
                self.update_next_at(&item.booking_id, now + CHECKIN_AUTH_RETRY_MS);
            }
            return;
        }
        for item in due {
            if now > item.deadline_ms {
                self.finish_missed(&item, "已过签到窗口");
                continue;
            }
            let result = self
                .auth
                .client
                .action(Action::CheckIn, &item.booking_id)
                .await;
            match result {
                Ok(_) => {
                    self.pending
                        .lock()
                        .expect("check-in pending poisoned")
                        .remove(&item.booking_id);
                    self.set_message(format!("已自动签到：{}", item.booking_id));
                    let _ = self.store.write_audit(
                        "checkin_succeeded",
                        &serde_json::json!({"bookingId": item.booking_id}),
                    );
                }
                Err(error) => {
                    let message = error.to_string();
                    if message.contains("已签到") || message.contains("重复签到") {
                        self.pending
                            .lock()
                            .expect("check-in pending poisoned")
                            .remove(&item.booking_id);
                        self.set_message(format!("已自动签到：{}", item.booking_id));
                        let _ = self.store.write_audit(
                            "checkin_succeeded",
                            &serde_json::json!({"bookingId": item.booking_id, "message": message}),
                        );
                    } else if is_non_pending_checkin_error(&message) {
                        self.reconcile_non_pending_checkin(&item.booking_id, &message, now)
                            .await;
                    } else if message.contains("请求过于频繁") {
                        // 实测：封禁期内继续提交无效，等满服务端声明的 10 分钟。
                        self.update_next_at(&item.booking_id, now + CHECKIN_BAN_MS);
                        let _ = self.store.write_audit(
                            "checkin_failed",
                            &serde_json::json!({"bookingId": item.booking_id, "error": message}),
                        );
                    } else if matches!(error, hdu_sniper_hdu::HduError::AuthenticationExpired(_)) {
                        let restored = self.auth.restore().await;
                        self.update_next_at(
                            &item.booking_id,
                            now + if restored {
                                CHECKIN_WRITE_POLL_MS
                            } else {
                                CHECKIN_AUTH_RETRY_MS
                            },
                        );
                        let _ = self.store.write_audit(
                            "checkin_failed",
                            &serde_json::json!({"bookingId": item.booking_id, "error": message}),
                        );
                    } else {
                        // 固定轮询：不翻倍、不设次数上限，直到签到窗口截止。
                        self.update_next_at(&item.booking_id, now + CHECKIN_WRITE_POLL_MS);
                        let _ = self.store.write_audit(
                            "checkin_failed",
                            &serde_json::json!({"bookingId": item.booking_id, "error": message}),
                        );
                    }
                }
            }
        }
    }

    /// 馆方报“状态非待签到状态”时（例如已提前手动签到或已取消），
    /// 回查预约列表核对真实状态：已入座则按成功收尾，已取消/结束则停止轮询，
    /// 避免在窗口内每 10 秒空打一次无效写入。
    async fn reconcile_non_pending_checkin(&self, booking_id: &str, message: &str, now: i64) {
        let Ok(bookings) = self.auth.client.bookings().await else {
            self.update_next_at(booking_id, now + CHECKIN_WRITE_POLL_MS);
            let _ = self.store.write_audit(
                "checkin_failed",
                &serde_json::json!({"bookingId": booking_id, "error": message}),
            );
            return;
        };
        self.observe_bookings(&bookings);
        let current = bookings
            .iter()
            .find(|item| item.get("id").map(value_to_string).as_deref() == Some(booking_id));
        let status = current
            .and_then(|item| item.get("status").map(value_to_string))
            .unwrap_or_default();
        if matches!(status.as_str(), "1" | "2") {
            self.set_message(format!("已自动签到：{booking_id}"));
            let _ = self.store.write_audit(
                "checkin_succeeded",
                &serde_json::json!({
                    "bookingId": booking_id,
                    "source": "synced",
                    "message": message,
                }),
            );
            return;
        }
        let still_pending = self
            .pending
            .lock()
            .expect("check-in pending poisoned")
            .contains_key(booking_id);
        if still_pending && status == "0" {
            self.update_next_at(booking_id, now + CHECKIN_WRITE_POLL_MS);
            let _ = self.store.write_audit(
                "checkin_failed",
                &serde_json::json!({"bookingId": booking_id, "error": message}),
            );
            return;
        }
        self.forget(booking_id);
        self.set_message(format!("签到已停止（{booking_id}）：{message}"));
        let _ = self.store.write_audit(
            "checkin_failed",
            &serde_json::json!({
                "bookingId": booking_id,
                "error": message,
                "terminal": true,
            }),
        );
    }

    fn update_next_at(&self, booking_id: &str, next_at: i64) {
        if let Some(item) = self
            .pending
            .lock()
            .expect("check-in pending poisoned")
            .get_mut(booking_id)
        {
            item.attempts += 1;
            item.next_at = next_at;
        }
    }

    fn finish_missed(&self, item: &PendingCheckIn, reason: &str) {
        self.pending
            .lock()
            .expect("check-in pending poisoned")
            .remove(&item.booking_id);
        self.set_message(format!("未签到：{reason}"));
        let _ = self.store.write_audit(
            "checkin_missed",
            &serde_json::json!({
                "bookingId": item.booking_id,
                "begin": item.begin_ms,
                "deadline": item.deadline_ms,
                "attempts": item.attempts,
                "reason": reason,
            }),
        );
    }

    fn has_enabled_plan(&self) -> bool {
        self.store
            .list_plan_items()
            .map(|items| {
                items.iter().any(|item| match item {
                    hdu_sniper_core::PlanListItem::Single(plan) => plan.enabled,
                    hdu_sniper_core::PlanListItem::Group(group) => group.enabled,
                })
            })
            .unwrap_or(false)
    }

    fn set_state(&self, state: &str) {
        self.status.lock().expect("scheduler status poisoned").state = state.into();
    }

    fn touch_last_run_at(&self) {
        self.status
            .lock()
            .expect("scheduler status poisoned")
            .last_run_at = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
    }

    fn set_message(&self, message: String) {
        let mut status = self.status.lock().expect("scheduler status poisoned");
        status.last_run_at = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
        status.last_message = Some(message);
    }
}

fn is_retryable_sync_error(error: &hdu_sniper_hdu::HduError) -> bool {
    matches!(
        error,
        hdu_sniper_hdu::HduError::RequestTimeout
            | hdu_sniper_hdu::HduError::Network(_)
            | hdu_sniper_hdu::HduError::Http(404 | 429 | 500..=599)
    )
}

fn is_non_pending_checkin_error(message: &str) -> bool {
    message.contains("非待签到")
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    use axum::{http::StatusCode, routing::get, routing::post, Json, Router};
    use hdu_sniper_auth::Endpoints;
    use hdu_sniper_store::Store;
    use serde_json::json;
    use tokio::net::TcpListener;

    use super::*;

    fn scheduler() -> Scheduler {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let auth = Arc::new(AuthService::new(store.clone()).unwrap());
        let booking = Arc::new(BookingExecutor::new(store.clone()));
        Scheduler::new(store, auth, booking)
    }

    async fn mock_scheduler(router: Router) -> (Arc<Store>, Scheduler) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let base = format!("http://{addr}");
        let endpoints = Endpoints {
            library: base.clone(),
            login_entry: format!("{base}/login"),
            sso: base.clone(),
            sso_login_page: format!("{base}/sso/login"),
            sso_csrf_script: format!("{base}/sso/csrf.js"),
        };
        let store = Arc::new(Store::open_in_memory().unwrap());
        let auth = Arc::new(
            AuthService::with_endpoints_and_secrets(store.clone(), endpoints, None).unwrap(),
        );
        auth.client.set_identity("u1".into(), "Tester".into());
        let booking = Arc::new(BookingExecutor::new(store.clone()));
        let scheduler = Scheduler::new(store.clone(), auth, booking);
        scheduler.set_auto_check_in(true, true);
        (store, scheduler)
    }

    #[test]
    fn observes_bookings_that_need_a_check_in() {
        let scheduler = scheduler();
        scheduler.set_auto_check_in(true, true);
        let now = Utc::now();
        let begin = now.timestamp() + 120;
        scheduler.observe_bookings_at(
            &[json!({"id": "b1", "time": begin, "status": "0", "limitSignBack": 1800})],
            now,
        );
        let (booking_id, at) = scheduler.next_check_in().unwrap();
        assert_eq!(booking_id, "b1");
        assert_eq!(at, (begin + 60) * 1000);
        assert!(scheduler.status().check_in_polling.unwrap().active);
        scheduler.note_checked_in("b1");
        assert!(scheduler.next_check_in().is_none());
    }

    #[test]
    fn disabled_auto_check_in_clears_pending() {
        let scheduler = scheduler();
        scheduler.set_auto_check_in(true, true);
        let now = Utc::now();
        scheduler.observe_bookings_at(
            &[json!({"id": "b1", "time": now.timestamp() + 120, "status": "0", "limitSignBack": 1800})],
            now,
        );
        assert!(scheduler.next_check_in().is_some());
        scheduler.set_auto_check_in(false, false);
        assert!(scheduler.next_check_in().is_none());
        assert!(!scheduler.auto_check_in_enabled());
    }

    #[test]
    fn ignores_checked_in_and_expired_bookings() {
        let scheduler = scheduler();
        scheduler.set_auto_check_in(true, true);
        let now = Utc::now();
        scheduler.observe_bookings_at(
            &[
                json!({"id": "checked", "time": now.timestamp() + 120, "status": "1", "limitSignBack": 1800}),
                json!({"id": "expired", "time": now.timestamp() - 1800, "status": "0", "limitSignBack": 60}),
            ],
            now,
        );
        assert!(scheduler.next_check_in().is_none());
    }

    #[tokio::test]
    async fn sync_check_ins_retries_404_and_preserves_last_message() {
        let calls = Arc::new(AtomicUsize::new(0));
        let future_begin = Utc::now().timestamp() + 3600;
        let router = Router::new().route(
            "/Seat/Index/myBookingList",
            get({
                let calls = calls.clone();
                move || {
                    let calls = calls.clone();
                    async move {
                        let attempt = calls.fetch_add(1, AtomicOrdering::SeqCst);
                        if attempt < 2 {
                            (
                                StatusCode::NOT_FOUND,
                                Json(json!({"CODE": "NotFound", "ui_type": "com.Message"})),
                            )
                        } else {
                            (
                                StatusCode::OK,
                                Json(json!({
                                    "CODE": "ok",
                                    "content": {
                                        "defaultItems": [{
                                            "id": "23173125",
                                            "time": future_begin,
                                            "status": "0",
                                            "limitSignBack": 1800
                                        }]
                                    }
                                })),
                            )
                        }
                    }
                }
            }),
        );
        let (store, scheduler) = mock_scheduler(router).await;
        scheduler.set_message("预约任务完成".into());

        scheduler.sync_check_ins_with_delays(&[10, 10, 10]).await;

        assert_eq!(calls.load(AtomicOrdering::SeqCst), 3);
        assert_eq!(
            scheduler.next_check_in().map(|(id, _)| id),
            Some("23173125".to_string())
        );
        assert_eq!(
            scheduler.status().last_message.as_deref(),
            Some("预约任务完成")
        );
        let audits = store.list_audit(10).unwrap();
        assert_eq!(audits.len(), 1);
        assert_eq!(audits[0].event, "checkin_sync_failed");
        assert_eq!(audits[0].payload["willRetry"], json!(true));
    }

    #[tokio::test]
    async fn checkin_tick_stops_when_booking_is_no_longer_pending() {
        let checkin_calls = Arc::new(AtomicUsize::new(0));
        let begin = Utc::now().timestamp() - 120;
        let router = Router::new()
            .route(
                "/Seat/Index/checkIn",
                post({
                    let checkin_calls = checkin_calls.clone();
                    move || {
                        let checkin_calls = checkin_calls.clone();
                        async move {
                            checkin_calls.fetch_add(1, AtomicOrdering::SeqCst);
                            Json(json!({
                                "CODE": "ParamError",
                                "MESSAGE": "当前状态无法操作，状态非待签到状态"
                            }))
                        }
                    }
                }),
            )
            .route(
                "/Seat/Index/myBookingList",
                get(move || async move {
                    Json(json!({
                        "CODE": "ok",
                        "content": {
                            "defaultItems": [{
                                "id": "23163913",
                                "time": begin,
                                "status": "6",
                                "limitSignBack": 1800
                            }]
                        }
                    }))
                }),
            );
        let (store, scheduler) = mock_scheduler(router).await;
        scheduler.observe_bookings_at(
            &[json!({"id": "23163913", "time": begin, "status": "0", "limitSignBack": 1800})],
            Utc::now() - chrono::Duration::seconds(3),
        );
        assert!(scheduler.next_check_in().is_some());

        scheduler.checkin_tick().await;
        scheduler.checkin_tick().await;

        assert_eq!(checkin_calls.load(AtomicOrdering::SeqCst), 1);
        assert!(scheduler.next_check_in().is_none());
        let audits = store.list_audit(10).unwrap();
        assert_eq!(audits.len(), 1);
        assert_eq!(audits[0].event, "checkin_failed");
        assert_eq!(audits[0].payload["terminal"], json!(true));
    }

    #[tokio::test]
    async fn checkin_tick_marks_synced_in_use_booking_as_succeeded() {
        let begin = Utc::now().timestamp() - 120;
        let router = Router::new()
            .route(
                "/Seat/Index/checkIn",
                post(|| async {
                    Json(json!({
                        "CODE": "ParamError",
                        "MESSAGE": "当前状态无法操作，状态非待签到状态"
                    }))
                }),
            )
            .route(
                "/Seat/Index/myBookingList",
                get(move || async move {
                    Json(json!({
                        "CODE": "ok",
                        "content": {
                            "defaultItems": [{
                                "id": "23163914",
                                "time": begin,
                                "status": "1",
                                "limitSignBack": 1800
                            }]
                        }
                    }))
                }),
            );
        let (store, scheduler) = mock_scheduler(router).await;
        scheduler.observe_bookings_at(
            &[json!({"id": "23163914", "time": begin, "status": "0", "limitSignBack": 1800})],
            Utc::now() - chrono::Duration::seconds(3),
        );

        scheduler.checkin_tick().await;

        assert!(scheduler.next_check_in().is_none());
        let audits = store.list_audit(10).unwrap();
        assert_eq!(audits.len(), 1);
        assert_eq!(audits[0].event, "checkin_succeeded");
        assert_eq!(audits[0].payload["source"], json!("synced"));
    }

    #[tokio::test]
    async fn sync_check_ins_logs_final_failure_when_retries_exhausted() {
        let calls = Arc::new(AtomicUsize::new(0));
        let router = Router::new().route(
            "/Seat/Index/myBookingList",
            get({
                let calls = calls.clone();
                move || {
                    let calls = calls.clone();
                    async move {
                        calls.fetch_add(1, AtomicOrdering::SeqCst);
                        (
                            StatusCode::NOT_FOUND,
                            Json(json!({"CODE": "NotFound", "ui_type": "com.Message"})),
                        )
                    }
                }
            }),
        );
        let (store, scheduler) = mock_scheduler(router).await;
        scheduler.set_message("预约任务完成".into());

        scheduler.sync_check_ins_with_delays(&[10, 10]).await;

        assert_eq!(calls.load(AtomicOrdering::SeqCst), 3);
        assert_eq!(
            scheduler.status().last_message.as_deref(),
            Some("预约任务完成")
        );
        let audits = store.list_audit(10).unwrap();
        assert_eq!(audits.len(), 2);
        assert_eq!(audits[0].payload["willRetry"], json!(false));
        assert_eq!(audits[1].payload["willRetry"], json!(true));
    }

    #[tokio::test]
    async fn checkin_tick_keeps_retrying_when_reconcile_bookings_fails() {
        let checkin_calls = Arc::new(AtomicUsize::new(0));
        let begin = Utc::now().timestamp() - 120;
        let router = Router::new()
            .route(
                "/Seat/Index/checkIn",
                post({
                    let checkin_calls = checkin_calls.clone();
                    move || {
                        let checkin_calls = checkin_calls.clone();
                        async move {
                            let n = checkin_calls.fetch_add(1, AtomicOrdering::SeqCst);
                            if n == 0 {
                                Json(json!({
                                    "CODE": "ParamError",
                                    "MESSAGE": "当前状态无法操作，状态非待签到状态"
                                }))
                            } else {
                                Json(json!({
                                    "CODE": "ok",
                                    "DATA": {"result": "success"}
                                }))
                            }
                        }
                    }
                }),
            )
            .route(
                "/Seat/Index/myBookingList",
                get(|| async {
                    (
                        StatusCode::NOT_FOUND,
                        Json(json!({"CODE": "NotFound", "ui_type": "com.Message"})),
                    )
                }),
            );
        let (store, scheduler) = mock_scheduler(router).await;
        scheduler.observe_bookings_at(
            &[json!({"id": "23163915", "time": begin, "status": "0", "limitSignBack": 1800})],
            Utc::now() - chrono::Duration::seconds(3),
        );

        scheduler.checkin_tick().await;
        assert!(scheduler.next_check_in().is_some());

        // 模拟进入下一轮到期时刻，再次触发签到并成功
        scheduler.update_next_at("23163915", Utc::now().timestamp_millis() - 1);
        scheduler.checkin_tick().await;

        assert_eq!(checkin_calls.load(AtomicOrdering::SeqCst), 2);
        assert!(scheduler.next_check_in().is_none());
        let audits = store.list_audit(10).unwrap();
        assert_eq!(audits[0].event, "checkin_succeeded");
        assert_eq!(audits[1].event, "checkin_failed");
    }

    #[tokio::test]
    async fn checkin_tick_already_checked_in_does_not_emit_failed_audit() {
        let begin = Utc::now().timestamp() - 120;
        let router = Router::new().route(
            "/Seat/Index/checkIn",
            post(|| async {
                Json(json!({
                    "CODE": "ParamError",
                    "MESSAGE": "您已签到，请勿重复签到"
                }))
            }),
        );
        let (store, scheduler) = mock_scheduler(router).await;
        scheduler.observe_bookings_at(
            &[json!({"id": "23163916", "time": begin, "status": "0", "limitSignBack": 1800})],
            Utc::now() - chrono::Duration::seconds(3),
        );

        scheduler.checkin_tick().await;

        assert!(scheduler.next_check_in().is_none());
        let audits = store.list_audit(10).unwrap();
        assert_eq!(audits.len(), 1);
        assert_eq!(audits[0].event, "checkin_succeeded");
    }
}
