# 部署说明

[返回项目首页](../README.md) · [开发与发布](DEVELOPMENT.md)

## 配置环境变量

学号、数字杭电密码和会话 Cookie 由登录页保存在本地 SQLite 数据库中，首次使用时在登录页登录即可；Cookie 失效时会使用已保存的凭据自动重新登录。退出登录只清除会话，不会清除已保存凭据。

如需自定义部署参数，复制 `.env.example` 为本地未跟踪的 `.env.local`，按需填写：

```dotenv
HDU_SNIPER_HOME=/path/to/hdu-library-sniper
HDU_WEB_PORT=8000
```

凭据和 SQLite 数据库会明文保存在数据目录中，请确保设备、容器数据卷和数据卷权限仅限当前用户访问。不要提交 `.env.local`、密码、Cookie 或 SQLite 数据库。

## 容器部署

### Docker Compose

准备配置文件：

```bash
cp .env.example .env.local
```

确认 `.env.local` 中的部署参数后构建并启动：

```bash
docker compose up -d --build
```

访问 `http://localhost:8000`。查看日志和停止服务：

```bash
docker compose logs -f hdu-sniper
docker compose down
```

数据保存在 Docker 命名卷 `hdu-sniper-data` 中，包含 SQLite 数据库、Cookie 和预约审计记录。删除容器不会删除该卷；如需清空数据，确认后再执行：

```bash
docker compose down -v
```

### Podman

项目提供了 Podman 脚本：

```bash
cp .env.example .env.local
bun run podman:build
bun run podman:up
```

默认情况下 `podman:up` 还会安装宿主机 systemd 开机自启服务 `hdu-library-sniper.service`，开机时自动拉起容器（预约由容器内常驻服务在 20:00 程序内触发，与桌面端一致）。如不需要开机自启：

```bash
HDU_SKIP_SYSTEMD_AUTOSTART=1 bun run podman:up
```

脚本是按 rootful Podman 设计的；rootless Podman 需要自行配置 `enable-linger` 与用户级 unit。也可以用 `bun run autostart:install` / `autostart:uninstall` 单独管理。

```bash
bun run podman:down
```

#### 预构建镜像

`.github/workflows/image.yml` 会在推送到 `main` 时构建容器镜像并推送到 GitHub Container Registry，部署机可以直接使用镜像，不必 clone 仓库或在本地安装 Bun/Node 工具链：

```bash
podman pull ghcr.io/alaichhe/hdu-library-sniper:latest
```

手动启动（不需要自动更新时）：

```bash
podman volume create hdu-sniper-data 2>/dev/null || true
podman run -d --name hdu-library-sniper \
  --restart=always \
  --publish 8000:8000 \
  --volume hdu-sniper-data:/var/lib/hdu-sniper:Z \
  ghcr.io/alaichhe/hdu-library-sniper:latest
```

镜像 tag：

- `latest`：`main` 分支最新一次构建；
- `sha-<short>`：按提交固定的版本，便于回滚；
- `v*`：仓库打 tag 时发布的版本。

如果 ghcr 包是私有的，需要先在宿主机登录一次 `podman login ghcr.io -u <GitHub 用户名>`；公开包可以匿名拉取（GitHub → Packages → hdu-library-sniper → Package settings 可调整可见性）。

#### Podman 自动更新

自动更新只拉取上面发布的镜像，不在宿主机上构建，也不需要 Git 工作区。安装 systemd 定时器：

```bash
sudo bun run podman:auto-update:install
```

安装脚本会把更新逻辑复制到 `/usr/local/sbin/hdu-library-sniper-auto-update`，systemd 指向这个副本，因此安装完成后即使删除仓库目录也不影响定时任务。安装后每天凌晨 03:15（Asia/Shanghai）检查一次，并随机延迟最多 15 分钟。每次检查会：

1. `podman pull` 目标镜像并记录镜像 ID；
2. 如果运行中的容器已经是这个镜像，只做健康检查后退出；
3. 否则用临时数据卷启动候选容器并检查 `/api/health`；
4. 健康检查通过后替换生产容器并删除上一版容器；
5. 回收旧的本地构建镜像与悬空层；
6. 替换失败时恢复旧容器。

配置位于：

```text
/etc/default/hdu-library-sniper-auto-update
```

可以修改 `HDU_SNIPER_IMAGE`、`HDU_SNIPER_CONTAINER_NAME`、`HDU_SNIPER_VOLUME`、`HDU_SNIPER_BIND_ADDRESS`、`HDU_SNIPER_HOST_PORT`、`HDU_SNIPER_READY_TIMEOUT_SECONDS`。如果宿主机上还跑着其他 Podman 工作负载、不希望执行全局悬空镜像清理，可以设置：

```bash
HDU_SNIPER_PRUNE_IMAGES=0
```

生产数据继续保存在 `hdu-sniper-data` 命名卷中，不会因更新删除。查看占用与镜像：

```bash
podman system df
podman images -f reference='ghcr.io/*/hdu-library-sniper*'
```

宿主机不需要保留仓库，日常操作直接用 systemd：

```bash
systemctl list-timers hdu-library-sniper-auto-update.timer   # 下一次触发时间
sudo systemctl start hdu-library-sniper-auto-update.service  # 立即检查一次
journalctl -u hdu-library-sniper-auto-update.service -n 50   # 最近一次日志
```

如果你想修改更新逻辑，需要在临时 clone 里改完并重新执行 `sudo bun run podman:auto-update:install`，它会把新版本复制到 `/usr/local/sbin`。卸载自动更新（不会删除应用容器或数据）：

```bash
sudo bun run podman:auto-update:uninstall
```

也可以在任意 clone 里使用 `sudo bun run podman:auto-update:status` / `podman:auto-update`，它们只是对上面 systemd 命令的封装。

容器 WebUI 是单租户管理界面，不建议直接暴露到公网。请放在可信内网或已认证的反向代理之后。
