# Docker 快速入口

```bash
cp config.example.yaml deploy/config/settings.yaml
cp .env.example .env
docker compose build
docker compose --profile web up -d
```

打开 `http://localhost:8000` 使用 Web UI。立即执行一次：

```bash
docker compose --profile run run --rm hdu-sniper-run
```

定时运行：

```bash
docker compose --profile scheduled up -d
docker compose logs -f hdu-sniper-scheduled
```

配置目录、secret 文件和数据卷说明见 [docs/DOCKER.md](docs/DOCKER.md)。
