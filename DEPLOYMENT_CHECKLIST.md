# 部署检查清单

- [ ] `deploy/config/settings.yaml` 包含 `schema_version: 1`
- [ ] `deploy/config/plans.yaml` 至少有一个启用方案
- [ ] 学号与密码通过环境变量或 `*_FILE` secret 成对提供
- [ ] 后台容器中的配置挂载为只读
- [ ] `data` 与 `state` 使用持久化卷
- [ ] 时区与 `SCHEDULE` 已确认
- [ ] `docker compose --profile run run --rm hdu-sniper-run` 测试成功
- [ ] 日志与通知渠道测试成功
- [ ] 已选择容器 cron 或外部调度器，避免同时启用两套计划
