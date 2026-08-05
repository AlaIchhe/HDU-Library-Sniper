# C4 架构图（v2 — KMP 目标架构）

C4 模型源文件为 `workspace.dsl`，可通过 Structurizr CLI/MCP 校验、解析并导出 Mermaid / PlantUML / C4-PlantUML。目录内同时提供可直接渲染的 Mermaid C4 图与 PlantUML 图。

## 图

Mermaid：

- [系统上下文](context.mmd)
- [容器](containers.mmd)
- [组件](components.mmd)
- [部署](deployment.mmd)

PlantUML（C4-PlantUML）：

- [系统上下文](context.puml)
- [容器](containers.puml)
- [组件](components.puml)

## 模型约定（v2）

- 学生是唯一人设用户，可通过桌面端、Web 端或移动端使用。
- 慧图平台和杭电 SSO 是外部系统；微信 Webhook、GitHub Releases、OS 调度器（Task Scheduler / cron / launchd / AlarmManager / BGTask）是外部依赖。
- 所有业务逻辑只存在于 `KMP Shared Core`；桌面、Android、iOS、服务器只提供 UI、OS 调度与端口实现，不复制业务逻辑。
- 本地数据按类别拆分：config（普通配置）、plans（预约方案）、credentials（账号凭证）、sessions（Cookie 与会话）、logs（运行与审计日志）。
- 外部系统访问边界：慧图 → `HuituClient`；SSO → `SSOClient`；微信 → `Notifier`；GitHub → `UpdateService`；OS 调度 → 各平台壳的调度适配。

## 使用 Structurizr

当前 Codex 已注册 `structurizr` MCP。可要求模型读取 `workspace.dsl` 并执行：

```text
校验 DSL，然后导出 context / containers / components / deployment 视图为 Mermaid 和 PlantUML
```

`workspace.dsl` 描述的是 KMP 目标架构（v2），与旧版 Python/Flet 架构无关。
