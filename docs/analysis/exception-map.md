# 异常与错误映射

## 领域异常

| 异常 | 触发场景 | 处理策略 |
|---|---|---|
| `ConfigError` | 配置文件缺失版本、类型错误、未知节点、secret 冲突 | 启动即失败 |
| `SchedulePolicyError` | 星期为空或越界 | 调用方显示校验错误，不持久化 |
| `AuthenticationRequiredError` | 本地未认证时访问受保护操作 | UI/API 返回 401 |
| `AuthenticationExpiredError` | 远端 `is_login=false` 或 Cookie 失效 | 清理本地认证，发布 `AUTH_REQUIRED`，API 映射为 401 |
| `CookieError` | Cookie 字符串无有效键值、缓存为空 | 登录流程失败并给出提示 |
| `HduLibraryError` | 网络、HTTP、JSON、业务信封异常 | 转换为可展示错误；`is_timeout=true` 时做超时复核 |
| `RoomQueryError` | 房间类型/详情解析失败 | 方案创建或布局查询失败 |
| `SeatQueryError` | 楼层缺失、座位不存在、重复座位号 | 方案校验或执行失败 |
| `UpdateCancelled` | 用户取消下载 | UI 中断下载 |
| `UpdateChecksumError` | 下载不完整或 SHA-256 不匹配 | 删除临时文件，提示校验失败 |

## 重试决策

`default_retry_decider` 按 `MESSAGE` 子串判定，不能只看 `CODE`：

| 消息 | 决策 |
|---|---|
| `超出可预约座位时间范围` | continue，等待窗口 |
| `已有预约，请勿重复预约！` | skip 当前方案 |
| `选择的座位无法预约...` | skip 当前座位，切备用 |
| `非法请求` | stop 整个任务 |
| 其他失败 | skip 当前方案 |
| `CODE=ok` | continue |

## 本地 FastAPI 错误映射

| 场景 | HTTP |
|---|---|
| 未认证 | `401 authentication required` |
| 预约 ID 非数字或当前账户不存在 | `404` |
| 业务动作不允许、任务冲突、同步失败 | `409` |
| 系统调度读取失败 | `503` |
| `/api/docs`、`/api/openapi.json` | `404` |

## 事件状态机

```text
idle -> authenticating -> idle / failed
idle -> running -> succeeded / failed / cancelled
running -> cancelling -> cancelled
```

事件类型：`state`、`auth`、`auth_required`、`progress`、`result`、`error`。
