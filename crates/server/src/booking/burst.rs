use super::classify::*;
use super::*;

impl BookingExecutor {
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

    pub(crate) async fn run_attempt<C: BookingClient>(
        &self,
        client: &C,
        dry_run: bool,
        finished: Option<(&mut Vec<BookingMemberResult>, bool)>,
    ) -> BookingRunResult {
        let enabled = self
            .store
            .list_plan_items()
            .ok()
            .and_then(|items| items.into_iter().find(is_enabled));
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

    pub async fn lock_burst<C: BookingClient>(
        &self,
        client: &C,
        deadline_ms: u64,
    ) -> BookingLockResult {
        let Some(enabled) = self
            .store
            .list_plan_items()
            .ok()
            .and_then(|items| items.into_iter().find(is_enabled))
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
