# GitHub Actions 配置

仓库中的 `.github/workflows/book-seat.yml` 使用临时 `HDU_SNIPER_HOME`，运行结束后会删除全部配置和会话文件。

在仓库 Settings → Secrets and variables → Actions 中配置：

- `HDU_STUDENT_ID`：学号。
- `HDU_PASSWORD`：数字杭电密码。
- `HDU_PLANS_YAML`：完整的 `plans.yaml` 内容。
- `HDU_CONFIG_YAML`：可选，完整的 `settings.yaml` 内容，必须包含 `schema_version: 1`。
- `WEBHOOK_URL`：可选，工作流结果通知地址。

先通过 `workflow_dispatch` 手动运行验证，再启用定时触发。GitHub 托管 Runner 的排队与跨境网络延迟不可控，不适合作为严格卡点的主链路。
