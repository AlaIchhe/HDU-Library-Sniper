# 领域模型（KMP 目标架构）

> 本文描述 KMP 共享核心（`core/`）中的领域模型与模块边界。外部慧图契约见 `contracts/`。

## 有界上下文

| 上下文 | 核心职责 |
|---|---|
| 身份与会话 | 杭电统一身份认证、慧图 Cookie、UID 解析 |
| 场馆目录 | 房间类型、楼层、座位布局与座位定位 |
| 预约方案 | 方案 CRUD、参数校验、本地持久化 |
| 抢座执行 | 预温、定时、重试、回退座位、结果复核、审计 |
| 预约生命周期 | 预约记录状态、签到、暂离、续座、签退、取消 |
| 调度策略 | 星期规则、暂停、下一次预约日、系统任务 |
| 通知与审计 | 日志、微信 webhook、系统通知 |
| 应用更新 | 版本检查、下载校验、启动安装器 |

## 模块边界与依赖方向

```text
平台壳（desktop / android / ios / container）
        │ 调用
        ▼
   UseCases（用例编排）
        │
        ├──► Domain（模型与规则，无平台依赖）
        ├──► Library（慧图/SSO HTTP、解析、签名）
        └──► Ports（persistence / secrets / notifier / scheduler 接口）
```

- `domain` 不依赖任何其他模块，所有规则可独立测试。
- `usecases` 依赖端口接口而非具体实现；平台壳负责注入 SQLite/DataStore、Keystore/Keychain 等实现。
- `library` 依赖 `domain` 的 DTO 与 kotlinx.serialization，不依赖 UI 或平台 API。
- 依赖方向严格单向：平台壳 → usecases → domain / library / ports。

## 核心实体

### Credentials

- `student_id`：学号。
- `password`：数字杭电密码。
- 来源优先级：环境变量/secret 文件 > 平台安全存储（SecretsPort）> `credentials.yaml`（桌面/服务器兼容）。
- 文件持久化使用原子写入，并设置 `0o600`。

### LibrarySession

- 慧图域 `hdu.huitu.zhishulib.com` 的 Cookie 集合。
- 缓存于 `SessionStore`（SQLite/DataStore；JVM 兼容 `session.cache`）。
- 会话有效性由 `GET /User/Center/baseInfo` 的 `DATA.is_login=true` 和 `DATA.uid` 数字串确认。

### RoomType / Floor / Seat

- `RoomType`：房间大类，代码 `1..4`，显示名由 `ROOM_TYPE_MAP` 映射。
- `Floor`：由 `seatMap.info.id` 标识，`seatMap.POIs` 是座位集合。
- `Seat`：`id` 是预约 API 使用的座位 ID，`title` 是用户可读座位号。
- 创建方案时合并今天、明天、后天三天的布局，只有全部三天查询失败才报错。

### BookingPlan

聚合根，代表一次预约的完整参数：

| 字段 | 约束 |
|---|---|
| `room_type` | `1..4` |
| `floor_id` | 正整数 |
| `seat_num` | 非空 |
| `start_hour` | `0..23` |
| `duration_hours` | 正整数 |
| `fallback_seats` | 列表，元素非空，自动去重 |
| `status` | `enabled` / `disabled` |

派生规则：

- `seat_candidates`：主座位在前，备用座位在后，去重。
- `to_plan_code()`：`room_type:floor_id:seat_num:start_hour:duration_hours`，用于审计和事件载荷。

### BookingOrder

外部系统中的预约记录，字段契约见 `contracts/schemas.md`。

关键字段：

- `id`：预约记录 ID，写操作使用。
- `seatNum`：座位号。
- `time`：开始时间戳。
- `status`：服务端状态码。
- `limitSignAgo` / `limitSignBack` / `nowTime`：签到窗口判定。

状态机：

```text
pending --进入签到窗口--> check_in --签到--> in_use
in_use --暂离--> away --续座/返回--> in_use
in_use --签退--> finished / system_signed_out
pending / pending_confirmation --取消--> cancelled
away --未按时返回--> away_expired
```

### SchedulePolicy

- `enabled`：暂停/启用。
- `weekdays`：`1..7`，至少一个。
- 损坏或非法文件安全降级为 `corrupt=true` 且暂停，不允许静默按默认规则抢座。

### ScheduledTask

由平台壳创建的 OS 级任务，任务名保持：

- 每日抢座：`HDU-Library-Sniper-Daily`，每天 `20:00:00`。
- 自动签到登录触发：`HDU-Library-Sniper-CheckIn-Logon`。
- 签到窗口任务：`HDU-Library-Sniper-CheckIn-*`。

平台映射：

| 平台 | 调度机制 |
|---|---|
| 桌面 / 服务器 | Windows Task Scheduler / cron / launchd |
| Android | AlarmManager（`setAlarmClock()`）+ 前台服务 + `BOOT_COMPLETED` 重建 |
| iOS | BGTask + AppIntent + 用户显式创建的快捷指令自动化 |

应用只允许读取和操作这些受管任务，其他任务名会抛 `ValueError`（Kotlin 中为 `IllegalArgumentException`）。

## 核心组件（core 内部）

| 组件 | 职责 |
|---|---|
| `Domain` | 模型、业务规则、状态机与 DTO，无平台依赖 |
| `UseCases` | 用例编排：认证守卫、应用状态机、事件发布、预约操作门禁、抢座、签到、复核、策略评估 |
| `HuituClient` | 慧图 HTTP：Cookie 会话、信封解析、魔法路径访问器、`MSG_*` 常量单一源 |
| `SSOClient` | 杭电 CAS 登录：表单登录、AES-128/ECB/Pkcs7 密码加密、ticket 落地 |
| `ApiSigning` | `bookSeats` Api-Token 签名（`base64(md5(source))`） |
| `Persistence` | 仓库端口 + SQLite/DataStore/文件实现：settings / plans / credentials / session / audit |
| `SecretsPort` | 平台安全存储端口：Keystore / Keychain / DPAPI / OS keyring |
| `Notifier` | 通知端口：微信 webhook、系统通知 |
| `UpdateService` | 版本比较、安装包下载、SHA-256 校验 |

## 端口（Ports）

核心只定义接口，平台壳提供实现：

| 端口 | 接口示例 | 平台实现 |
|---|---|---|
| `SettingsRepository` | 读写普通配置 | JVM YAML/文件；Android DataStore；iOS DataStore |
| `PlansRepository` | 方案 CRUD | JVM YAML；移动端 SQLite/DataStore |
| `CredentialRepository` | 读写凭据 | JVM 文件(0600)；移动端 Keystore/Keychain |
| `SessionRepository` | 读写 Cookie 会话 | JVM `session.cache`；移动端 SQLite/DataStore |
| `AuditLogger` | 写入审计日志 | JVM 文本文件；移动端 SQLite |
| `SchedulerPort` | 注册/查询/触发受管任务 | 各平台调度机制 |
| `NotifierPort` | 发送微信 webhook | JVM Ktor Client；移动端 Ktor Client |
