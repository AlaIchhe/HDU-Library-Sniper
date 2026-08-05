# 接口文档

- [本地 API（Ktor）](API.md)
- [慧图外部 API 契约](../contracts/00_overview.md)
- [慧图响应契约（Kotlin 形状）](../contracts/schemas.md)

> OpenAPI 说明：生产构建关闭 `/api/docs` 与 `/api/openapi.json`（返回 `404`）。项目脚手架完成后，OpenAPI 3.1 规范由 `container/server` 的 Ktor 路由生成（Ktor OpenAPI 插件），不再由 Python FastAPI 生成。
