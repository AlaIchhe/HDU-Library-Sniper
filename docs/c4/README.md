# C4 架构图

C4 模型源文件为 `workspace.dsl`，可用 Structurizr MCP 校验、解析并导出 Mermaid / PlantUML / C4-PlantUML。仓库内同时提供可直接渲染的 Mermaid C4 图。

## 图

- [系统上下文](context.mmd)
- [容器](containers.mmd)
- [组件](components.mmd)
- [部署](deployment.mmd)

## 约定

- 学生是唯一人类用户。
- 慧图平台和杭电 SSO 是外部系统。
- 微信 Webhook、GitHub Releases、OS 调度器是外部依赖。
- 本地文件系统保存配置、凭证、会话、计划和审计日志。

## 使用 Structurizr MCP

当前 Codex 已注册 `structurizr` MCP。重新启动会话后，可要求模型读取 `workspace.dsl` 并执行：

```text
校验 DSL，然后导出 context / containers / components 视图为 Mermaid 和 PlantUML
```

`workspace.dsl` 已通过 Structurizr MCP 的 `validate` 校验，返回 `OK`。
