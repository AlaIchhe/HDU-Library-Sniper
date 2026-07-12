# Docker/服务器配置目录

部署前可将仓库根目录的 `config.example.yaml` 复制为本目录的
`settings.yaml`，并在本目录创建 `plans.yaml`。运行时该目录以只读方式
挂载，凭据应通过环境变量或 secret 文件提供。
