use super::classify::*;
use super::*;

impl BookingExecutor {
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn execute_plan<C: BookingClient>(
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
        // 座位图是否被并发保护挡回。必须独立记录：本轮若接着提交了预锁座位，
        // last 会被提交结果覆盖， busy 标记就丢了——而 20:00 有预锁时正是这种情况，
        // 上层的写入槽冻结会因此完全失效。
        let mut seat_query_busy = false;
        // 座位图每轮只查一次：它只用于把座位号解析成 seatId 并筛掉已占座位。
        // 实测 2026-11-13：提交前并不强制重新查询（免查询提交同样成功），
        // 因此不必为每个候选各查一次，省下的读取时间留给提交。
        let floors = match client
            .floors(&plan.room_query, begin, plan.duration_hours)
            .await
        {
            Ok(floors) => Some(floors),
            Err(error) => {
                // 实测：读路径无速率限制，404 是服务端并发保护（CODE=NotFound），
                // 并发退去即刻恢复。标记出来让上层按 POLL_MS 快速重试。
                seat_query_busy = matches!(error, HduError::Http(404));
                last = BookingMemberResult {
                    seat_query_busy,
                    ..BookingMemberResult::failure(
                        plan,
                        None,
                        format!("房间或座位查询失败: {error}"),
                    )
                };
                // 查询失败时仍可提交已预锁的座位（seatId 已知），否则本轮无候选可试。
                None
            }
        };
        for seat_num in candidates {
            let seat_id = preferred
                .filter(|lock| lock.seat_num == seat_num)
                .map(|lock| lock.seat_id.clone())
                .or_else(|| {
                    floors
                        .as_ref()
                        .and_then(|floors| seat_id_from_floors(floors, plan, &seat_num))
                });
            let Some(seat_id) = seat_id else {
                if floors.is_none() {
                    continue;
                }
                last = BookingMemberResult::failure(
                    plan,
                    Some(seat_num.clone()),
                    format!("找不到座位 {seat_num}"),
                );
                continue;
            };
            // 实测（quota 探针）：被拒的提交同样计入写入额度——亚秒级下第 1 次
            // 业务失败后第 2 次即限流；桶有余量耗尽时 10s 节拍第 2 次直接封号。
            // 20:00 全馆约 20% 座位 state!=0，故先按座位图筛掉已占座位，
            // 把与成功提交共用同一份的稀缺额度留给真正空闲的座位。
            if let Some(floors) = floors.as_ref() {
                if !seat_is_free(floors, plan, &seat_num) {
                    last = BookingMemberResult::failure(
                        plan,
                        Some(seat_num.clone()),
                        format!("座位 {seat_num} 已被占用"),
                    );
                    continue;
                }
            }
            if dry_run {
                return BookingMemberResult {
                    plan_id: plan.id.clone(),
                    seat_num: Some(seat_num),
                    success: true,
                    message: "预演成功，未提交预约请求".into(),
                    seat_query_busy,
                    ..BookingMemberResult::default()
                };
            }
            let response = match self
                .paced_write(|| client.book_seat(&seat_id, begin, plan.duration_hours))
                .await
            {
                Ok(response) => response,
                Err(error) => {
                    let result = self
                        .booking_failure(client, plan, begin, &seat_num, error, snapshot)
                        .await;
                    if result.success || result.terminal || result.unverified {
                        return BookingMemberResult {
                            seat_query_busy,
                            ..result
                        };
                    }
                    last = result;
                    continue;
                }
            };
            let result = self
                .finalize_booking(client, plan, begin, &seat_num, response, snapshot)
                .await;
            if result.success || result.terminal || result.unverified {
                return BookingMemberResult {
                    seat_query_busy,
                    ..result
                };
            }
            last = result;
        }
        BookingMemberResult {
            seat_query_busy,
            ..last
        }
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
            // 固定轮询：不再按错误类型抬高睡眠，交由写入节拍统一限速。
            Some("throttle") | Some("flow") => {
                BookingMemberResult::failure(plan, Some(seat_num.into()), message)
            }
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
            match client.bookings().await {
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

    pub(crate) async fn booked_begin_times<C: BookingClient>(
        &self,
        client: &C,
        finished: &mut Vec<BookingMemberResult>,
    ) -> Option<std::collections::HashSet<i64>> {
        let _ = finished;
        match client.bookings().await {
            Ok(items) => Some(
                items
                    .iter()
                    .map(|item| item.get("time").map(value_to_i64).unwrap_or(0))
                    .collect(),
            ),
            Err(_) => None,
        }
    }
}
