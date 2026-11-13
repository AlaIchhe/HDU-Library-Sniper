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
        // 固定轮询：interval_ms 是读取节拍，不随失败翻倍；写入另有独立节拍。
        self.read_interval_ms.store(interval_ms.max(1), Ordering::Relaxed);
        self.abort_prelock();
        let started = Instant::now();
        let deadline = started + Duration::from_millis(timeout_ms);
        let mut finished: Vec<BookingMemberResult> = Vec::new();
        let mut unverified: std::collections::HashMap<String, u8> =
            std::collections::HashMap::new();
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
                self.locked_seats.lock().expect("locked seats poisoned").clear();
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
            // 固定间隔轮询，无抖动、无指数退避；只保证不睡过 deadline。
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .as_millis() as u64;
            self.poll_sleep_ms(interval_ms.max(1).min(remaining)).await;
        }
    }

    /// 轮询间隔的睡眠。单独抽出以便测试只断言轮询节奏，
    /// 不与请求节拍（paced/paced_write）的等待混在一起。
    async fn poll_sleep_ms(&self, ms: u64) {
        #[cfg(test)]
        if let Some(log) = self.poll_log.as_ref() {
            log.lock().expect("poll log poisoned").push(ms);
        }
        self.sleep_ms(ms).await;
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
        let (finished_items, first_attempt) = match finished {
            Some((items, first)) => (items.clone(), first),
            None => (Vec::new(), false),
        };
        // 开窗首轮用 19:59 预锁时的快照，省掉 20:00 第一秒的一次列表查询。
        let snapshot = self
            .booked_snapshot
            .lock()
            .expect("booked snapshot poisoned")
            .clone();
        let booked = if first_attempt && snapshot.is_some() {
            snapshot
        } else {
            let live = self.booked_begin_times(client, &mut Vec::new()).await;
            if let Some(set) = live.as_ref() {
                *self.booked_snapshot.lock().expect("booked snapshot poisoned") = Some(set.clone());
            }
            live
        };
        let now = Utc::now();
        let mut results = Vec::new();
        let finished_map: std::collections::HashMap<String, BookingMemberResult> = finished_items
            .into_iter()
            .map(|item| (item.plan_id.clone(), item))
            .collect();
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
                // 消费 19:59 的预锁：优先提交锁到的座位，省掉开窗时的座位解析。
                let preferred = self
                    .locked_seats
                    .lock()
                    .expect("locked seats poisoned")
                    .iter()
                    .find(|lock| lock.plan_id == plan.id && lock.begin_seconds == begin_seconds)
                    .cloned();
                let mut result = self
                    .execute_plan(
                        client,
                        &plan,
                        begin,
                        dry_run,
                        preferred.as_ref(),
                        None,
                        booked.as_ref(),
                    )
                    .await;
                if let Some(lock) = preferred.as_ref() {
                    if !result.success && !result.terminal && !result.unverified {
                        // 预锁失效（被占/过期）：丢锁后按主座位 + 备选重试，不死磕同一座位。
                        self.locked_seats
                            .lock()
                            .expect("locked seats poisoned")
                            .retain(|item| !(item.plan_id == lock.plan_id && item.begin_seconds == lock.begin_seconds));
                        // 锁定座位就是主座位且无备选时，跳过它会得到空候选，
                        // 这正是旧版“未找到可用座位”的成因，故此时保留主座位。
                        let skip = if plan.seat_num == lock.seat_num && plan.fallback_seats.is_empty()
                        {
                            None
                        } else {
                            Some(lock.seat_num.as_str())
                        };
                        result = self
                            .execute_plan(
                                client,
                                &plan,
                                begin,
                                dry_run,
                                None,
                                skip,
                                booked.as_ref(),
                            )
                            .await;
                    }
                }
                result
            };
            if result.success {
                self.booked_snapshot
                    .lock()
                    .expect("booked snapshot poisoned")
                    .get_or_insert_with(Default::default)
                    .insert(begin_seconds);
                self.locked_seats
                    .lock()
                    .expect("locked seats poisoned")
                    .retain(|item| !(item.plan_id == plan.id && item.begin_seconds == begin_seconds));
            }
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
                .find(|seat| {
                    seat_id_from_floors(&floors, &plan, seat).is_some()
                        && seat_is_free(&floors, &plan, seat)
                });
            let Some(seat_num) = seat_num else {
                continue;
            };
            let Some(seat_id) = seat_id_from_floors(&floors, &plan, &seat_num) else {
                continue;
            };
            let response = self
                .paced_write(|| client.lock_seat(&seat_id, begin, plan.duration_hours))
                .await;
            let locked = lock_succeeded(&response);
            // 实测：预锁与正式预约共用同一写入额度（累积桶，约 6 次即封号 10 分钟）。
            // 命中封禁必须立刻收手，否则会把 20:00 的预约额度一起打没。
            let banned = response.as_ref().is_ok_and(|body| {
                classify_booking_failure(&response_message(body)) == Some("ban")
            });
            locks.push(BookingLock {
                plan_id: plan.id.clone(),
                seat_id,
                seat_num,
                begin_seconds,
                duration_hours: plan.duration_hours,
                locked,
            });
            if banned {
                break;
            }
        }
        let success = !locks.is_empty() && locks.iter().all(|lock| lock.locked);
        let message = if success {
            "座位预锁成功".into()
        } else {
            "预锁未完成，不影响正式预约".into()
        };
        // 正式预约已抢占时不回写，避免把过期座位提示塞回去。
        if !self.prelock_aborted.load(Ordering::Relaxed) {
            *self.locked_seats.lock().expect("locked seats poisoned") = locks.clone();
            *self.booked_snapshot.lock().expect("booked snapshot poisoned") = Some(booked.clone());
        }
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
