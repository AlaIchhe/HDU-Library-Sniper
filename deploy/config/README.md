# Docker/服务器配置目录

部署前可将仓库根目录的 `config.example.yaml` 复制为本目录的
`settings.yaml`，并在本目录创建 `plans.yaml`。Web UI 以可写方式挂载该目录，
一次性和定时任务以只读方式挂载；凭据应通过环境变量或 secret 文件提供。
