# 业务规则与边界

## 产品硬规则

1. 预约目标日固定为后天：`today + BOOKING_DAY_OFFSET`，`BOOKING_DAY_OFFSET=2`。
2. 系统调度固定每天 `20:00:00` 执行，创建有效方案后静默确保该任务存在。
3. 签到窗口由服务端字段判定：`begin - limitSignAgo <= nowTime <= begin + limitSignBack`。
4. 自动签到必须同意当前版本协议，协议版本为 `2026-08-02.1`。
5. 启用自动签到先持久化配置，再同步系统任务；任一步失败必须回滚开关。
6. 后端运行只认 `--daemon` / `--run-now` 等无 UI 模式，Web 模式为 Flet Web 单租户。

## 抢座执行边界

| 参数 | 默认值 | 边界 |
|---|---|---|
| `max_trials` | 5 | 必须 >= 1 |
| `retry_delay` | 1.0 秒 | 必须 >= 0，指数退避 `delay * 2^(attempt-1)` 再随机化 |
| `window_wait_seconds` | 30.0 秒 | 必须 >= 0 |
| `window_poll_interval` | 1.0 秒 | 必须 > 0 |
| `check_in_retry_interval` | 120.0 秒 | 必须 > 0，运行时下限 10 秒 |

执行顺序：

1. 按方案顺序处理。
2. 每个方案按主座位、备用座位顺序处理。
3. 每个座位最多 `max_trials` 次。
4. 成功返回后立即停止整个任务。
5. `time_out_of_range` 表示窗口未开放，等待并重试，受 `window_wait_seconds` 限制。
6. 未知错误采用 fail-closed 策略：只有 `CODE=ok` 才算成功。
7. 备用座位切换只在仍有候选座位时发生。

## 结果判定

- 预约接口成功响应不直接视为成功。
- 必须通过 `myBookingList?fromType=web` 复核 `seatNum + time(±1s) + duration` 三者匹配。
- 超时后也要做同样复核，防止“服务端已写入但响应超时”。
- 复核查询是 best-effort：结构漂移返回 `[]`，不升级为硬错误。

## 预约操作门禁

| 操作 | 允许状态 | 成功后状态 |
|---|---|---|
| 取消 | `0` / `8` | `4` 或记录消失 |
| 签到 | `0` 且进入签到窗口 | `1` |
| 暂离 | `1` | `2` |
| 返回座位 | `2` | `1` |
| 续座 | `2` | `1` |
| 签退 | `1` | `3` / `7` |

说明：

- `6`（暂离未归）不允许恢复。
- 操作成功后必须从预约列表复核最终状态。
- 取消允许“记录消失”视为成功；其他操作不允许。

## 调度策略边界

- `weekdays` 为空抛 `SchedulePolicyError`。
- 星期值不在 `1..7` 抛 `SchedulePolicyError`。
- 策略文件缺失时使用“每天、启用”的兼容默认值。
- 策略文件损坏时安全暂停，不按默认规则执行。
- `next_booking_date()` 从 `today + 2` 开始查找，最多 90 天。
- 人工执行 `run_booking_override` 绕过暂停和星期规则。

## 配置边界

- `settings.yaml` 根节点必须是映射。
- `schema_version` 必须等于当前版本，未知顶层节点拒绝加载。
- `dry_run` 和 `auto_check_in.enabled` 必须是布尔值。
- `HDU_STUDENT_ID` 与 `HDU_PASSWORD` 必须成对出现，禁止与对应 `_FILE` 同时设置。
- 所有可写路径必须是绝对路径。

## 安全边界

- 未认证状态禁止任何业务查询、方案操作、抢座、签到和调度管理。
- 远端明确返回 `is_login=false` 时立即清除本地认证状态并发布 `AUTH_REQUIRED`。
- FastAPI 生产构建关闭 `/api/docs` 和 `/api/openapi.json`。
- `/api/v1/status` 不暴露密码或凭证。
- 审计日志不写 Cookie、密码或请求签名。
