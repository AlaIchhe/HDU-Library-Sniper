# 领域模型

## 有界上下文

| 上下文 | 核心职责 | 主要模块 |
|---|---|---|
| 身份与会话 | 杭电统一身份认证、慧图 Cookie、UID 解析 | `library/login.py`, `library/client.py`, `config.py` |
| 场馆目录 | 房间类型、楼层、座位布局与座位定位 | `library/rooms.py`, `library/responses.py` |
| 预约方案 | 方案 CRUD、参数校验、YAML 持久化 | `booking/plans.py`, `booking/models.py` |
| 抢座执行 | 预温、定时、重试、回退座位、结果复核、审计 | `booking/runner.py`, `booking/retry.py`, `booking/time.py` |
| 预约生命周期 | 预约记录状态、签到、暂离、续座、签退、取消 | `application.py`, `library/responses.py` |
| 调度策略 | 星期规则、暂停、下一次预约日、系统任务 | `schedule_policy.py`, `scheduler.py` |
| 通知与审计 | 日志、微信 webhook、系统通知 | `notifier.py`, `booking/runner.py` |
| 应用更新 | 版本检查、下载校验、启动安装器 | `updater.py` |

## 核心实体

### Credentials

- `student_id`：学号。
- `password`：数字杭电密码。
- 来源优先级：环境变量/secret 文件 > `credentials.yaml`。
- 持久化使用原子写入，并设置 `0o600`。

### LibrarySession

- 慧图域 `hdu.huitu.zhishulib.com` 的 Cookie 集合。
- 缓存文件：`session.cache`。
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

外部系统中的预约记录，字段契约见 `docs/contracts/schemas.md`。

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

由应用创建的 OS 级任务：

- 每日抢座：`HDU-Library-Sniper-Daily`，每天 `20:00:00`。
- 自动签到登录触发：`HDU-Library-Sniper-CheckIn-Logon`。
- 签到窗口任务：`HDU-Library-Sniper-CheckIn-*`。

应用只允许读取和操作这些受管任务，其他任务名会抛 `ValueError`。

## 领域服务

| 服务 | 职责 |
|---|---|
| `LibraryLogin` | Cookie 缓存复用、CAS 表单登录、AES-128/ECB/Pkcs7 密码加密 |
| `LibraryRooms` | 房间查询、楼层布局合并、按楼层 ID + 座位号定位座位 |
| `BookingRunner` | 单例活动任务、预温、定时等待、重试、回退座位、结果复核 |
| `SniperApp` | 应用状态机、事件发布、认证守卫、预约操作门禁 |
| `SchedulerService` | Windows / Linux / macOS 系统任务管理 |
| `UpdateService` | 版本比较、安装包下载与 SHA-256 校验 |
