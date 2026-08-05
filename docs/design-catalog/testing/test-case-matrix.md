# 测试用例矩阵

## 覆盖范围

现有 pytest 套件覆盖主要领域规则、外部契约、UI 行为和更新流程。以下矩阵按业务能力列出代表性测试，便于追溯。

## 配置与持久化

| 用例 | 验证点 | 测试 |
|---|---|---|
| 配置加载 | schema 版本、未知节点、类型错误 | `tests/test_settings.py` |
| 凭证加载 | 环境变量优先级、secret 文件、成对校验 | `tests/test_settings.py` |
| 路径规则 | 必须绝对路径、`HDU_SNIPER_HOME` 便携布局 | `tests/test_settings.py`, `tests/test_packaged_runtime.py` |

## 方案与边界

| 用例 | 验证点 | 测试 |
|---|---|---|
| 方案字段边界 | 房间类型 1..4、楼层 > 0、小时 0..23、时长 > 0 | `tests/test_boundary_rules.py` |
| 备用座位 | 去重、顺序、非列表拒绝 | `tests/test_boundary_rules.py` |
| 方案 CRUD | 持久化、缓存、删除、修改时间 | `tests/test_supporting_services.py` |

## 时间规则

| 用例 | 验证点 | 测试 |
|---|---|---|
| 预约日固定后天 | 跨日/跨月不受影响 | `tests/test_booking_rules.py` |
| 三天布局合并 | 单日失败容忍、全失败报错 | `tests/test_booking_rules.py` |
| execute_at 解析 | ISO UTC、无时区 CST、秒/毫秒时间戳、空值拒绝 | `tests/test_boundary_rules.py` |

## 抢座执行

| 用例 | 验证点 | 测试 |
|---|---|---|
| 结果判定 | 只有 `CODE=ok` 成功，fail-closed | `tests/test_supporting_services.py` |
| 重试决策 | 窗口继续、重复跳过、非法请求停止 | `tests/test_supporting_services.py` |
| 超时复核 | 超时后列表确认成功/失败 | `tests/test_booking_runner.py` |
| 执行流程 | 首个成功停止、备用座位切换、取消、窗口截止 | `tests/test_booking_runner.py` |

## 调度策略

| 用例 | 验证点 | 测试 |
|---|---|---|
| 星期规则 | 空集合拒绝、越界拒绝、暂停/工作日/周末 | `tests/test_schedule_policy.py` |
| 下一次预约日 | 从后天开始、跨月、90 天上限 | `tests/test_schedule_policy.py` |
| 损坏文件 | 安全暂停而非默认执行 | `tests/test_schedule_policy.py` |
| 系统任务 | 固定 20:00、受管任务名限制 | `tests/test_booking_rules.py`, `tests/test_application.py` |

## 预约生命周期

| 用例 | 验证点 | 测试 |
|---|---|---|
| 状态映射 | pending / check_in / in_use / away / 终态 | `tests/test_contracts.py`, `tests/test_boundary_rules.py` |
| 签到窗口 | 缺字段 fail-closed | `tests/test_contracts.py` |
| 写操作门禁 | 取消 0/8、签到 0、暂离 1、返回/续座 2 | `tests/test_application.py` |
| 操作后复核 | 状态不符返回失败、取消允许记录消失 | `tests/test_application.py` |

## 认证与会话

| 用例 | 验证点 | 测试 |
|---|---|---|
| Cookie 缓存 | 有效复用、失败回退 | `tests/test_library_login.py` |
| SSO 表单 | 字段解析、AES 加密、隐藏字段 | `tests/test_library_login.py` |
| 会话过期 | 清理本地状态、发布 AUTH_REQUIRED | `tests/test_application.py` |

## 本地 API

| 用例 | 验证点 | 测试 |
|---|---|---|
| 健康检查 | 不依赖认证，先于 Flet 挂载 | `tests/test_api.py` |
| 认证守卫 | 受保护路由返回 401 | `tests/test_api.py`, `tests/test_boundary_rules.py` |
| 错误映射 | 404、409、503 | `tests/test_boundary_rules.py` |
| 自动签到 | 开关、协议版本、任务就绪 | `tests/test_api.py` |

## 外部 API 契约

| 用例 | 验证点 | 测试 |
|---|---|---|
| 响应结构 | 房间、座位、baseInfo、预约列表、bookSeats 样例 | `tests/test_contracts.py` |
| 消息常量 | `MSG_*` 与样例一致 | `tests/test_contracts.py` |
| 请求构建 | Api-Token、查询参数、无 token 的写操作 | `tests/test_library_client.py` |

## 通知与更新

| 用例 | 验证点 | 测试 |
|---|---|---|
| 通知 | 日志、webhook、系统通知、失败容错 | `tests/test_supporting_services.py` |
| 版本比较 | 稳定版、预发布、v 前缀 | `tests/test_updater.py` |
| 下载 | 进度、取消、SHA-256、不完整文件 | `tests/test_updater.py` |

## 建议补充

- 在真实或 mock 登录态下跑一次 `qa_audit`，验证本地 FastAPI 端点的 happy path 和边界。
- 对 `docs/c4/workspace.dsl` 增加 Structurizr DSL 校验测试，防止架构模型漂移。
- 对 `docs/api/openapi.json` 增加“本地接口数量/路径集合”回归断言，避免路由悄悄变化。
