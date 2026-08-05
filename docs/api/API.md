# HDU Library Sniper 本地 API

## 总则

- Base URL：Web 模式下默认 `http://<host>:8000`。
- 所有 `/api/v1` 业务接口都需要当前进程内有认证状态；未认证返回 `401`。
- 写操作成功后会从预约列表复核最终状态，因此部分接口返回前会有额外查询。
- `/api/docs` 和 `/api/openapi.json` 在生产中返回 `404`。

## 系统

| 方法 | 路径 | 认证 | 说明 | 成功 | 错误 |
|---|---|---|---|---|---|
| GET | `/api/v1/health` | 否 | 健康检查 | `{"status":"ok"}` | - |
| GET | `/api/v1/status` | 是 | 应用状态、方案数量 | `{state, authenticated, plans, enabled_plans}` | 401 |

## 预约查询

| 方法 | 路径 | 认证 | 说明 | 成功 | 错误 |
|---|---|---|---|---|---|
| GET | `/api/v1/bookings` | 是 | 当前账户预约记录 | `{bookings: BookingView[]}` | 401 |
| GET | `/api/v1/bookings/{booking_id}/status` | 是 | 读取单条预约服务端状态，不写 | `{response: HuituEnvelope}` | 401, 404 |
| GET | `/api/v1/bookings/{booking_id}/latest-comeback-time` | 是 | 读取暂离后最晚返回时间，不写 | `{response: HuituEnvelope}` | 401, 404 |

`BookingView` 字段：

```json
{
  "booking_id": "1",
  "room_name": "四楼自习室",
  "seat_num": "298",
  "start_text": "2026-08-05 08:00",
  "duration_text": "1 小时",
  "status": "0",
  "state": "pending",
  "status_label": "待签到",
  "summary": "四楼自习室 · 座位 298 · 2026-08-05 08:00",
  "can_cancel": true,
  "can_check_in": false,
  "can_sign_out": false,
  "can_leave": false,
  "can_renew": false,
  "show_in_list": true
}
```

## 抢座

| 方法 | 路径 | 认证 | 说明 | 成功 | 错误 |
|---|---|---|---|---|---|
| POST | `/api/v1/booking/run` | 是 | 执行抢座 | `{success, attempts, results[]}` | 401, 409 |

查询参数：

- `execute_at`：可选，ISO 8601 时间、秒级或毫秒级 Unix 时间戳；不传立即执行。

`results[]` 字段：

```json
{
  "plan_id": "abc123",
  "seat_num": "298",
  "success": true,
  "verified": true,
  "message": "预约成功，已完成列表复核",
  "elapsed_ms": 123.45
}
```

## 预约操作

`booking_id` 必须是数字，否则返回 `404`。

| 方法 | 路径 | 认证 | 允许状态 | 成功后状态 | 说明 |
|---|---|---|---|---|---|
| DELETE | `/api/v1/bookings/{booking_id}` | 是 | 0 / 8 | 4 或记录消失 | 取消预约 |
| POST | `/api/v1/bookings/{booking_id}/check-in` | 是 | 0 且在窗口内 | 1 | 签到 |
| POST | `/api/v1/bookings/{booking_id}/come-back` | 是 | 2 | 1 | 返回座位 |
| POST | `/api/v1/bookings/{booking_id}/renew` | 是 | 2 | 1 | 续座 |
| POST | `/api/v1/bookings/{booking_id}/leave` | 是 | 1 | 2 | 暂离 |
| POST | `/api/v1/bookings/{booking_id}/sign-out` | 是 | 1 | 3 / 7 | 签退 |
| POST | `/api/v1/bookings/{booking_id}/check-in-test` | 是 | 0 | - | 只测试签到窗口，不写 |

成功响应：

```json
{"success": true, "message": "签到成功，座位使用中"}
```

不允许的状态返回 `409`。

## 自动签到

| 方法 | 路径 | 认证 | 说明 | 成功 | 错误 |
|---|---|---|---|---|---|
| POST | `/api/v1/bookings/auto-check-in` | 是 | 对所有可签到预约执行签到 | `{results[]}` | 401 |
| GET | `/api/v1/auto-check-in` | 是 | 开关、协议版本、任务就绪状态 | `{enabled, agreement_version, agreed_at, current_agreement_version, consent_valid, tasks_ready}` | 401 |
| POST | `/api/v1/auto-check-in/enable` | 是 | 同意协议并同步系统任务 | `{"success": true, "message": "..."}` | 401, 409 |
| POST | `/api/v1/auto-check-in/disable` | 是 | 关闭并移除任务 | `{"success": true, "message": "..."}` | 401, 409 |

## 调度管理

| 方法 | 路径 | 认证 | 说明 | 成功 | 错误 |
|---|---|---|---|---|---|
| GET | `/api/v1/schedules` | 是 | 列出应用受管任务 | `{tasks: ScheduledTaskView[]}` | 401, 503 |
| POST | `/api/v1/schedules/{task_name}/run` | 是 | 请求任务计划程序立即运行 | `{"success": true, "message": "..."}` | 401, 404, 409 |
| DELETE | `/api/v1/schedules/{task_name}` | 是 | 删除应用受管任务 | `{"success": true, "message": "..."}` | 401, 404, 409 |

`ScheduledTaskView` 字段：

```json
{
  "name": "HDU-Library-Sniper-Daily",
  "status": "Ready",
  "next_run": "2026-08-05 20:00:00",
  "last_run": "2026-08-04 20:00:00",
  "last_result": "0"
}
```

## 错误模型

```json
{"detail": "authentication required"}
```

| 场景 | HTTP | detail 示例 |
|---|---|---|
| 未认证 | 401 | `authentication required` |
| booking_id 非法或账户中不存在 | 404 | `预约 ID 必须是数字` / `当前账户中找不到预约 ID=...` |
| 业务动作不允许 | 409 | `当前预约状态为 1，不能暂离` |
| 抢座冲突 | 409 | `没有启用的预约方案` |
| 调度读取失败 | 503 | `无法读取 Windows 任务计划程序: ...` |

## 慧图外部 API

慧图信封：

```json
{"CODE": "ok", "MESSAGE": "...", "DATA": {...}}
```

只有 `CODE="ok"` 且需要时 `DATA.result="success"` 才算业务成功。

| 方法 | 路径 | 用途 | 特殊点 |
|---|---|---|---|
| GET | `/Space/Category/list` | 房间类型 | `LAB_JSON=1` |
| GET | `/Seat/Index/searchSeats?{query}` | 房间详情 | 返回小写 `data` |
| POST | `/Seat/Index/searchSeats` | 座位分布图 | 返回 `allContent` |
| GET | `/User/Center/baseInfo` | 用户会话与 UID | 不带 `LAB_JSON` |
| POST | `/Seat/Index/bookSeats` | 提交预约 | 需要 `Api-Token` |
| GET | `/Seat/Index/myBookingList?fromType=web` | 预约列表 | `content.defaultItems` |
| POST | `/Seat/Index/cancelBooking?bookingId=` | 取消 | 无请求体 |
| POST | `/Seat/Index/checkIn?bookingId=` | 签到 | 无请求体 |
| POST | `/Seat/Index/comeBack?bookingId=` | 返回/续座 | 无请求体 |
| POST | `/Seat/Index/leave?bookingId=` | 暂离 | 无请求体 |
| POST | `/Seat/Index/signOut?bookingId=` | 签退 | 无请求体 |
| GET | `/Seat/Index/bookingStatus?bookingId=` | 单条状态 | 只读 |
| GET | `/Seat/Index/stepOutLatestComeBackTime?bookingId=` | 最晚返回时间 | 只读 |

完整外部契约见 `../contracts/00_overview.md` 与 `../contracts/schemas.md`。
