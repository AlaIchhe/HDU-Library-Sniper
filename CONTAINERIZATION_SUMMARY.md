# 容器化设计摘要

- `HDU_SNIPER_HOME=/var/lib/hdu-sniper` 是容器唯一运行根目录。
- `config/` 由宿主机挂载；后台容器只读，GUI 调试容器可写。
- `data/` 与 `state/` 使用 Docker 命名卷。
- 凭据直接来自环境变量或 `*_FILE` secret，不写入持久化配置。
- `run` profile 执行一次后退出；`scheduled` profile 提供常驻 cron。
- 生产环境优先使用外部调度器启动一次性容器。

完整说明见 [docs/DOCKER.md](docs/DOCKER.md)。
