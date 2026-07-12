# Docker 部署

容器固定使用 `/var/lib/hdu-sniper` 作为 `HDU_SNIPER_HOME`：

```text
/var/lib/hdu-sniper/
├── config/   # settings.yaml、plans.yaml，只读挂载
├── data/     # session.cache，持久化卷
└── state/    # 日志，持久化卷
```

## 准备配置

```bash
cp config.example.yaml deploy/config/settings.yaml
# 使用 GUI 创建方案，或自行准备 deploy/config/plans.yaml
cp .env.example .env
```

`settings.yaml` 只保存业务设置，不允许配置文件系统路径。凭据通过环境变量提供：

```dotenv
HDU_STUDENT_ID=学号
HDU_PASSWORD=密码
```

生产环境优先挂载 secret 文件并设置：

```dotenv
HDU_STUDENT_ID_FILE=/run/secrets/student_id
HDU_PASSWORD_FILE=/run/secrets/password
```

应用直接读取环境变量或 secret 文件；入口脚本不会将凭据写入持久化卷。

## 构建与运行

```bash
docker compose build

# 立即执行一次
docker compose --profile run run --rm hdu-sniper-run

# 容器内 cron 定时执行
docker compose --profile scheduled up -d
docker compose logs -f hdu-sniper-scheduled
```

定时规则在 `.env` 中设置：

```dotenv
SCHEDULE=0 20 * * *
```

生产编排环境更推荐使用宿主机 systemd timer、Kubernetes CronJob 或其他外部调度器启动一次性 `run-now` 容器。

## GUI 容器

GUI 容器只适合 Linux X11 调试；正式桌面端应直接运行本机应用，让程序使用操作系统标准用户目录。

```bash
xhost +local:docker
docker compose --profile gui up
```

GUI profile 将 `deploy/config` 以可写方式挂载，以便保存方案；后台 profile 始终只读挂载配置。

## 数据边界

- `deploy/config`：运维控制的设置与方案。
- `sniper-data`：会话缓存等持久状态。
- `sniper-state`：文件日志。
- stdout/stderr：由 Docker 日志驱动收集。

删除容器不会删除命名卷。确需清除所有状态时再执行：

```bash
docker compose down -v
```
