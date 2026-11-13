# 慧图馆方限制实测（2026-11-13）

真实账号实测所得，非推测。原始报文与凭据仅留在本机 `artifacts/probe/`（已 gitignore），本文已脱敏。

## 1. 读写限流是两套量级

| 路径 | 接口 | 间隔 | 结果 |
|---|---|---|---|
| 读 | `POST /Seat/Index/searchSeats` | 1.1s × 40 | 全部 200，**零限流**，单次 199–498ms |
| 写 | `POST /Seat/Index/bookSeats` | 1.1s | #2 `请求太频繁了` → #3 `请求过于频繁，请10分钟后再试` |
| 写 | 同上 | 3s（紧接前一轮后） | #2 直接封禁 |
| 写 | 同上 | 5s | 首轮 8/8 通过；**次轮 #6 封禁** |
| 写 | 同上 | 10s | 两阶段共 12 次写入（lock/book/unlock/cancel）未被限流 |

- 写入额度是**累积桶**，不是单次间隔判定：5s 首轮通过只是窗口未耗尽。
- 封禁**只影响写入**：封禁期内读接口 1.1s × 3 仍全部 200。
- 封禁时长与服务端文案一致：等满 600s 后首个写请求即通过（两次封禁均复现）。
- 桶容量与窗口未测出确切值。已确认：**1.1s / 3s / 5s 都会触发封禁**；10s 在连续 12 次写入中通过。10s 之后的一次封禁发生在紧随其后的 5s 测试中，不能归因于 10s。

## 2. 座位可用性由 `POI.state` 决定

`seatMap.POIs[].state`（字符串或数字）：

| state | 提交结果 |
|---|---|
| `0` | `CODE=ok` / `result=success`，预约成功 |
| `1` / `3` | `ParamError`：`选择的座位无法预约，可能座位不可用或已经被其他人锁定或占用` |

某时刻 +1 日 08:00 全馆分布：`{0: 1513, 1: 380, 3: 1}`。
**旧代码完全忽略 state**，会把提交次数浪费在已占座位上——而写入额度极其稀缺。

## 3. 预锁不是预约前提

- 对**空闲座位**（state=0）调 `lockSeats`：`CODE=ok`、`DATA.time>0`，但 **`DATA.result=fail`**；紧接着 `bookSeats` 直接成功。
- 对已占座位调 `lockSeats`：同样 `CODE=ok` + `time>0` + `result=fail`。
- 结论：`lockSeats` 只能当**座位提示**，`result=fail` 不代表不能预约；判定锁成功必须校验 `result=success`（旧代码只看 `time>0`，会误判）。

## 4. 提交前不强制重查座位图

预约 A → 取消 → **不做任何新 `searchSeats`** → 直接提交座位 B：`result=success`。
旧注释所称"服务端校验查询→提交流程"在实测中未出现。座位图查询仅用于解析 seatId 与筛 state，每轮一次即可。

## 5. 其他已确认契约

- `GET /User/Center/baseInfo` **不能带 `LAB_JSON=1`**：带了返回 UI 页 `com.BackRefreshPage`，不带才返回 `CODE=ok` + `DATA.is_login`。
- 业务失败文案取 `DATA.msg`，其次顶层 `MESSAGE`；预约成功需 `CODE=ok` **且** `DATA.result=success`。
- **取消预约成功时 `DATA` 内没有 `result` 字段**：实测原始报文为 `CODE=ok`、`MESSAGE=取消预约成功`，`DATA` 只含用户信息（`is_login`/`uid`/`uname` 等）。旧 `assert_action_success` 强求 `result=success`，会把成功取消误判为失败，并连带跳过 `scheduler.forget()`。现改为：`result` 存在时必须为 `success`，缺失时以 `CODE=ok` 为准；限流 `CODE=1` 仍被挡住。
  - 交叉验证：取消 A 后对同一时段提交 B 成功（未报"已有预约"），证明取消确实生效。
- 同时段重复提交：`ParamError` / `已有预约，请勿重复预约！`。
- 超出可约日期：`ParamError` / `超出可预约座位时间范围`。
- `range`：`minBeginTime=7`、`maxEndTime=22`、`min_duration=1`、`max_duration=15`、`max_num=4`，可约日期由 `advance_date`/`max_date` 界定。
- 签到窗口：`limitSignAgo=1800`、`limitSignBack=1800`（秒）。

## 6. 据此落地的代码

| 改动 | 依据 |
|---|---|
| 读固定轮询 1.1s，无抖动、无指数退避 | §1 读路径 40 次零限流 |
| 写入独立节拍 10s（`paced_write`） | §1 写入 1.1s/3s/5s 均会封禁 |
| 删除 `next_backoff_ms`、`MAX_BACKOFF_MS`、`retry_after_ms` | 固定轮询不再按错误抬高睡眠 |
| 签到固定 10s 轮询至窗口截止，去掉 8 次上限与指数退避 | §1 写入量级 + §5 窗口 |
| 命中 ban 仍立即停手并等 10 分钟 | §1 封禁期内写入无效 |
| 选座按 `state=0` 过滤 | §2 |
| `lock_succeeded` 增加 `result=success` 校验 | §3 |
| 预锁结果存入 executor 并被正式预约消费；失效则丢锁换备选 | §3 预锁仅作提示 |
| 座位图每轮只查一次；查询失败仍可提交已预锁座位 | §4 |
| `assert_action_success`：`result` 缺失时以 `CODE=ok` 为准 | §5 取消成功报文无 `result` |

对应回归测试：[booking.rs](../crates/server/src/booking.rs) 中标注"实测驱动"的用例（选座 state、预锁消费、固定轮询、预锁止损、查询失败直提），以及 [library.rs](../crates/hdu/src/library.rs) 中的取消契约用例。

## 7. 与原定"全部 1.1s"的偏差

读路径按要求取 1.1s。**写路径实测无法用 1.1s**：第 3 次即封号 10 分钟，等于抢座窗口内自毁。故写入按实测改 10s，并保留命中封禁立即停手（封禁期内提交无效，继续打只会空耗）。这是"以实测逻辑写代码"的直接结果，而非保留旧的退避设计。
