# HDU Library Sniper — KMP 目标架构

> 状态：架构设计基线（v2）。本目录文档已切换到 **Kotlin Multiplatform（KMP）重构路线**，不再描述旧版 Python + Flet + FastAPI 实现。

## 技术路线（已决策）

采用 **KMP 共享核心 + 原生调度壳**：

- 业务核心、持久化、HTTP、预约规则和签到规则全部用 Kotlin 表达，Android / iOS / 桌面 / Docker 共享同一份核心。
- Android 的 AlarmReceiver、前台服务和 `BOOT_COMPLETED` 重建直接调用 Kotlin 核心。
- iOS 的 App Intent / BGTask 调用 KMP 生成的共享框架，原生支持后台预算、`LongRunningIntent` 和快捷指令自动化。
- 桌面用 Compose Desktop 管理界面，调度器启动同一个 Kotlin 核心的 headless CLI/daemon。
- Docker 用 Ktor 提供 API/worker 和一个轻量 Web 管理面，核心仍然共享。
- 凭据、Cookie、方案、日志保存在当前设备或容器的本地安全存储中，不引入中心服务，不破坏“移动端独立本地实例”的产品边界。

## 模块结构

```text
core/                      # KMP 共享核心
  domain/                  # 模型、规则、DTO，无平台依赖
  usecases/                # 认证、方案、预约、签到、复核、策略评估、通知、更新
  library/                 # 慧图/SSO HTTP、响应解析、签名
  persistence/             # 仓库端口 + SQLite/DataStore 实现
  secrets/                 # 平台安全存储端口
desktop/
  compose_ui/              # Compose Desktop 管理界面
  cli/                     # headless daemon / run-now / checkin
android/
  app/                     # Compose UI + AlarmReceiver + FGS + BootReceiver
ios/
  app/                     # SwiftUI + AppIntent + BGTask
container/
  server/                  # Ktor API/worker，复用同一核心
  web/                     # 轻量 Web 管理面
```

## 关键设计决策

| 编号 | 决策 | 内容 |
|---|---|---|
| D1 | 单一业务核心 | 领域规则只存在于 `core`；平台壳（UI/调度/存储适配）不复制业务逻辑 |
| D2 | 端口与适配器 | `persistence`、`secrets`、`notifier`、`scheduler` 在核心内定义端口，各平台提供实现 |
| D3 | 原生调度壳 | OS 调度只负责唤醒；唤醒后直接进入 Kotlin 核心执行，不经过任何脚本运行时 |
| D4 | 本地数据主权 | 数据存在设备/容器本地；服务端形态下 API 与 Worker 共享同一核心和同一数据目录 |
| D5 | API 契约延续 | 本地 API 面沿用 `/api/v1` 契约（见 `api/API.md`），由 Ktor 实现 |
| D6 | 契约单一源 | 慧图响应访问器与 `MSG_*` 常量在 `core/library` 单一源，配套 commonTest 契约测试防漂移 |
| D7 | 凭据安全 | 学号/密码默认走平台安全存储（Keystore / Keychain / DPAPI）；桌面/服务器保留文件兼容但权限 `0600` |

## 文档索引

- [C4 架构图](c4/README.md) — 系统上下文、容器、组件、部署
- [需求与参与者](design-catalog/requirements.md)
- [领域模型](analysis/domain-model.md)
- [业务规则与边界](analysis/business-rules.md)
- [异常与错误映射](analysis/exception-map.md)
- [本地 API（Ktor）](api/API.md)
- [慧图外部 API 契约](contracts/00_overview.md)
- [慧图响应契约（Kotlin 形状）](contracts/schemas.md)

## 迁移状态

- [x] 架构设计（本文档 + `c4/`）
- [ ] `core` 脚手架与领域模型
- [ ] `library`（慧图/SSO/签名）移植
- [ ] `usecases` 移植
- [ ] 桌面 CLI/daemon 与 Compose UI
- [ ] Ktor Server + Web Admin
- [ ] Android / iOS 原生壳

旧版 Python 源码（仓库根目录 `src/`）仅作为迁移参考，不再作为文档的契约单一源。
