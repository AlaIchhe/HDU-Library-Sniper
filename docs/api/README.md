# 接口文档

- [本地 FastAPI 接口](API.md)
- [自动生成的 OpenAPI 3.1 JSON](openapi.json)
- [慧图外部 API 契约](../contracts/00_overview.md)
- [慧图响应 TypedDict 契约](../contracts/schemas.md)

生产构建关闭 `/api/docs` 和 `/api/openapi.json`，因此 OpenAPI JSON 由本地脚本从 `create_server_app()` 生成，不通过运行中的服务暴露。
