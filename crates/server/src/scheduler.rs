use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use hdu_sniper_auth::AuthService;
use hdu_sniper_core::json::{format_iso, value_to_i64, value_to_string};
use hdu_sniper_core::{
    booking_anchor_delay_seconds, booking_prelock_delay_seconds, shanghai_seconds_of_day,
    CheckInPolling, RuntimeStatus,
};
use hdu_sniper_hdu::Action;
use hdu_sniper_store::Store;
use serde_json::Value;
use tokio::time::sleep;

use crate::booking::BookingExecutor;

const CHECKIN_OFFSET_MS: i64 = 60_000;
const CHECKIN_RETRY_MS: i64 = 30_000;
const CHECKIN_MAX_RETRY_MS: i64 = 8 * 60_000;
const CHECKIN_THROTTLE_MS: i64 = 15_000;
const CHECKIN_AUTH_RETRY_MS: i64 = 10 * 60_000;
const CHECKIN_BAN_MS: i64 = 10 * 60_000;
const CHECKIN_MAX_ATTEMPTS: u32 = 8;

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
        if !self.auto_check_in_enabled() {
            self.pending
                .lock()
                .expect("check-in pending poisoned")
                .clear();
            return;
        }
        if !self.auth.authenticated() && !self.auth.restore().await {
            self.set_state("auth_required");
            return;
        }
        match self.auth.client.bookings().await {
            Ok(bookings) => {
                self.observe_bookings(&bookings);
                self.set_state("idle");
            }
            Err(error) => {
                self.set_message(error.to_string());
                let _ = self.store.write_audit(
                    "checkin_sync_failed",
                    &serde_json::json!({"error": error.to_string()}),
                );
            }
        }
    }

    pub async fn run_now(&self) -> serde_json::Value {
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
            self.sync_check_ins().await;
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

    async fn booking_loop(&self) {
        loop {
            if !self.has_enabled_plan() {
                sleep(Duration::from_secs(60)).await;
                continue;
            }
            let seconds = shanghai_seconds_of_day(Utc::now());
            let prelock = booking_prelock_delay_seconds(seconds, 60);
            if prelock > 0 {
                sleep(Duration::from_secs(prelock as u64)).await;
                if !self.has_enabled_plan() {
                    continue;
                }
                if !self.auth.authenticated() && !self.auth.restore().await {
                    self.set_state("auth_required");
                    continue;
                }
                self.set_state("running");
                let result = self.booking.lock_burst(&self.auth.client, 90_000).await;
                self.set_message(result.message);
                self.set_state("idle");
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
            let result = self
                .booking
                .run_burst(&self.auth.client, 4_000, 10 * 60_000)
                .await;
            self.set_message(result.message);
            self.set_state("idle");
            if result.success {
                self.sync_check_ins().await;
            }
        }
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
                        let _ = self.store.write_audit(
                            "checkin_succeeded",
                            &serde_json::json!({"bookingId": item.booking_id, "message": message}),
                        );
                    } else if message.contains("请求过于频繁") {
                        self.update_next_at(&item.booking_id, now + CHECKIN_BAN_MS);
                    } else if message.contains("请求太频繁了") {
                        self.update_next_at(&item.booking_id, now + CHECKIN_THROTTLE_MS);
                    } else if matches!(error, hdu_sniper_hdu::HduError::AuthenticationExpired(_)) {
                        let restored = self.auth.restore().await;
                        self.update_next_at(
                            &item.booking_id,
                            now + if restored {
                                60_000
                            } else {
                                CHECKIN_AUTH_RETRY_MS
                            },
                        );
                    } else {
                        let attempts = item.attempts + 1;
                        if attempts >= CHECKIN_MAX_ATTEMPTS {
                            self.finish_missed(&item, &format!("签到失败：{message}"));
                        } else {
                            let backoff = (CHECKIN_RETRY_MS * (1 << (attempts - 1)))
                                .min(CHECKIN_MAX_RETRY_MS);
                            self.update_next_at(&item.booking_id, now + backoff);
                        }
                    }
                    let _ = self.store.write_audit(
                        "checkin_failed",
                        &serde_json::json!({"bookingId": item.booking_id, "error": message}),
                    );
                }
            }
        }
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

    fn set_message(&self, message: String) {
        let mut status = self.status.lock().expect("scheduler status poisoned");
        status.last_run_at = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
        status.last_message = Some(message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hdu_sniper_store::Store;
    use serde_json::json;

    fn scheduler() -> Scheduler {
        let store = Arc::new(Store::open_in_memory().unwrap());
        let auth = Arc::new(AuthService::new(store.clone()).unwrap());
        let booking = Arc::new(BookingExecutor::new(store.clone()));
        Scheduler::new(store, auth, booking)
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
}
