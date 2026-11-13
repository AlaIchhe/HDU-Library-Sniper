use super::classify::*;
use super::*;

impl BookingExecutor {
    pub async fn run<C: BookingClient>(&self, client: &C) -> BookingRunResult {
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

    /// 开窗后的固定轮询：读请求直接发（实测无速率限制），
    /// 写入由 `paced_write` 按实测 10s 限速。轮询睡眠恒为 `POLL_MS`，无抖动、无退避。
    pub async fn run_burst<C: BookingClient>(
        &self,
        client: &C,
        timeout_ms: u64,
    ) -> BookingRunResult {
        let started = Instant::now();
        let deadline = started + Duration::from_millis(timeout_ms);
        let mut finished: Vec<BookingMemberResult> = Vec::new();
        let mut unverified: std::collections::HashMap<String, u8> =
            std::collections::HashMap::new();
        // 20:00 拥堵可观测性：记录 404 轮数与首次/恢复时刻，便于事后核对窗口
        let mut busy_rounds = 0u32;
        let mut busy_since: Option<Instant> = None;
        loop {
            let result = self.run_attempt(client, false, Some(&mut finished)).await;
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
            // 结束条件：全部成功、没有可继续的成员、或到点。
            // members 为空表示本轮没有任何可执行成员（例如今日不在方案的重复日期内），
            // 这种情况重试也不会有变化，必须立即结束——否则整个窗口空转。
            let pending = !result.members.is_empty()
                && result
                    .members
                    .iter()
                    .any(|member| !member.success && !member.terminal);
            if result.success || !pending || Instant::now() >= deadline {
                self.locked_seats
                    .lock()
                    .expect("locked seats poisoned")
                    .clear();
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
            // 座位图不可用只用于可观测性与写入槽冻结，不再影响轮询间隔：
            // 读路径无速率限制，任何失败都按同一个 POLL_MS 重试。
            let seat_query_busy = result.members.iter().any(|member| member.seat_query_busy);
            if seat_query_busy {
                busy_rounds += 1;
                if busy_since.is_none() {
                    busy_since = Some(Instant::now());
                    let _ = self.store.write_audit(
                        "booking_seat_query_busy",
                        &serde_json::json!({
                            "reason": "座位图不可用（404 并发保护或请求超时）",
                            "at": "first",
                        }),
                    );
                }
                // 20:00 拥堵可持续 1–2 分钟（用户实况）。这段时间写入槽会一直"过期"，
                // 若不处理，恢复瞬间攒下的欠账会让多个候选连发提交——而实测写入
                // 3 次即封号。故拥堵期间把写入槽顶到当前时刻，恢复后重新计时。
                *self.write_slot.lock().expect("pacing slot poisoned") = Instant::now();
            } else if let Some(since) = busy_since.take() {
                let _ = self.store.write_audit(
                    "booking_seat_query_recovered",
                    &serde_json::json!({
                        "busyRounds": busy_rounds,
                        "busyMs": since.elapsed().as_millis() as u64,
                    }),
                );
                // 轮数必须与 busyMs 同窗口：旧实现跨窗口累加，
                // 2026-11-13 第二段记成 10 轮（含第一段的 3 轮），与实际时长不符。
                busy_rounds = 0;
            }
            self.poll_sleep_ms(POLL_MS.min(remaining)).await;
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
        finished: Option<&mut Vec<BookingMemberResult>>,
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
        let finished_items = finished.map(|items| items.clone()).unwrap_or_default();
        let booked = self.booked_begin_times(client, &mut Vec::new()).await;
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
                // 消费 19:59 的预锁：优先提交锁到的座位。关键价值在于 seatId 已知——
                // 20:00 座位图可能持续 404，此时预锁是唯一的 seatId 来源。
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
                    // 只有"座位本身不可用"才丢锁。限流、未到点、座位图 404 都不说明
                    // 座位有问题：20:00 持续 404 时若丢掉预锁，seatId 就再也解析不出来
                    // （备选座位需要座位图），整个窗口会退化成只读不提交。
                    if !result.success
                        && !result.terminal
                        && !result.unverified
                        && !result.seat_query_busy
                        && is_seat_unavailable_message(&result.message)
                    {
                        // 预锁失效（被占）：丢锁后按主座位 + 备选重试，不死磕同一座位。
                        self.locked_seats
                            .lock()
                            .expect("locked seats poisoned")
                            .retain(|item| {
                                !(item.plan_id == lock.plan_id
                                    && item.begin_seconds == lock.begin_seconds)
                            });
                        // 锁定座位就是主座位且无备选时，跳过它会得到空候选，
                        // 这正是旧版“未找到可用座位”的成因，故此时保留主座位。
                        let skip =
                            if plan.seat_num == lock.seat_num && plan.fallback_seats.is_empty() {
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
                self.locked_seats
                    .lock()
                    .expect("locked seats poisoned")
                    .retain(|item| {
                        !(item.plan_id == plan.id && item.begin_seconds == begin_seconds)
                    });
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
        } else if results.is_empty() {
            // 今日不在任何成员的重复日期内：没有可执行成员，直接结束而非空转。
            "今日不在方案的重复日期内，无需预约".to_string()
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

    /// 19:59:00 预锁：对启用方案的**每个成员**各发一次请求
    /// （单方案 1 个成员；组合方案 N 个成员就 N 次），然后结束。
    /// 每个成员只请求一次，失败不回退、不兜底、不重试，只写日志。
    /// 正式预约照常按主座位 + 备选进行。
    ///
    /// 时间上界：写请求最坏 30s（`WRITE_TIMEOUT_SECONDS`），提前量 60s，
    /// 故最多容得下一个成员走满超时；正常路径每成员约 0.5s + 写入节拍。
    /// 写入节拍由 `paced_write` 按实测 10s 保证，不会撞馆方写入额度。
    pub async fn lock_once<C: BookingClient>(&self, client: &C) -> BookingLockResult {
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
        if members.is_empty() {
            return BookingLockResult {
                plan_id: Some(plan_id),
                kind: Some(kind),
                success: false,
                message: "方案没有成员".into(),
                ..BookingLockResult::default()
            };
        }
        let started = Instant::now();
        let now = Utc::now();
        let mut locks = Vec::new();
        let mut failures: Vec<String> = Vec::new();
        let mut attempted = 0usize;
        for plan in &members {
            let Some(begin) = member_begin(plan, now) else {
                failures.push(format!("{}：今日不在重复日期内", plan.seat_num));
                continue;
            };
            attempted += 1;
            // 每个成员各一次：失败只记原因，继续下一个成员，不重试、不换备选。
            match self.prelock_attempt(client, plan, begin).await {
                Ok(lock) => locks.push(lock),
                Err(reason) => failures.push(format!("{}：{reason}", plan.seat_num)),
            }
        }
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let success = attempted > 0 && failures.is_empty();
        // 真正锁住的成员数。实测空闲座位回 result=fail，故 held 常为 0——
        // 这不影响 seatId 可用性，只是让日志不再谎报"锁住了"。
        let held = locks.iter().filter(|lock| lock.locked).count();
        let message = if success {
            format!(
                "座位号已就绪（{}/{}，其中锁住 {}）",
                locks.len(),
                attempted,
                held
            )
        } else if failures.is_empty() {
            "今日无需预锁".to_string()
        } else {
            format!(
                "预锁 {}/{} 成功（失败不重试）：{}",
                locks.len(),
                attempted,
                failures.join("；")
            )
        };
        *self.locked_seats.lock().expect("locked seats poisoned") = locks.clone();
        let _ = self.store.write_audit(
            "booking_prelock_finished",
            &serde_json::json!({
                "planId": plan_id,
                "kind": kind,
                "success": success,
                "members": members.len(),
                "attempted": attempted,
                "elapsedMs": elapsed_ms,
                "locks": locks.len(),
                "held": held,
                "message": message,
            }),
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

    /// 单个成员的单次预锁：一次座位图查询 + 一次锁座。Err 即失败原因，交由调用方记日志。
    ///
    /// 保留 seatId 的条件是"座位空闲（state=0）且馆方受理了锁座（CODE=ok）"，
    /// **不要求 `DATA.result=success`**——实测空闲座位就是回 fail（§3）。
    async fn prelock_attempt<C: BookingClient>(
        &self,
        client: &C,
        plan: &BookingPlan,
        begin: DateTime<Utc>,
    ) -> Result<BookingLock, String> {
        let floors = client
            .floors(&plan.room_query, begin, plan.duration_hours)
            .await
            .map_err(|error| format!("座位查询失败: {error}"))?;
        let seat_id = seat_id_from_floors(&floors, plan, &plan.seat_num)
            .ok_or_else(|| format!("座位 {} 不在座位图中", plan.seat_num))?;
        if !seat_is_free(&floors, plan, &plan.seat_num) {
            return Err(format!("座位 {} 已被占用", plan.seat_num));
        }
        // 组合方案有 N 个成员就有 N 次锁座写请求，必须走实测的写入节拍，
        // 否则会撞上馆方累积额度（实测 3 次即封号 10 分钟）。
        let response = self
            .paced_write(|| client.lock_seat(&seat_id, begin, plan.duration_hours))
            .await
            .map_err(|error| format!("锁座失败: {error}"))?;
        if !lock_accepted(&Ok(response.clone())) {
            return Err(format!("锁座被拒: {}", response_message(&response)));
        }
        Ok(BookingLock {
            plan_id: plan.id.clone(),
            seat_id,
            seat_num: plan.seat_num.clone(),
            begin_seconds: begin.timestamp(),
            duration_hours: plan.duration_hours,
            // 只要 CODE=ok 就保留 seatId：实测空闲座位也回 result=fail（§3），
            // 据此丢号会让 20:00 座位图持续 404 时无号可提交
            // （2026-11-13 实战复现：locks=0，随后 12 轮空转 86s）。
            // locked 仅记录"是否真锁住"，供日志展示，不参与消费决策。
            locked: lock_effective(&Ok(response)),
        })
    }
}
