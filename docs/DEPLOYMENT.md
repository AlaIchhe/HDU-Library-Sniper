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

#### Podman 自动更新

如需让宿主机自动跟踪 GitHub 仓库 `origin/main` 并更新容器，可安装 systemd 定时器：

```bash
sudo bun run podman:auto-update:install
```

安装后，宿主机每天凌晨 03:15（Asia/Shanghai）检查一次更新，并随机延迟最多 15 分钟，避免固定时间集中执行。检查服务会：

1. 从 `origin/main` 拉取最新代码；
2. 在临时 Git worktree 中构建候选镜像；
3. 使用临时数据卷启动候选容器并检查 `/api/health`；
4. 健康检查通过后替换生产容器，并删除上一版容器；
5. 回收候选镜像 tag 与不再被引用的构建层；
6. 替换失败时恢复旧容器，并删除本轮构建的候选镜像。

候选镜像只是更新过程的临时产物：提升成功后镜像改由稳定的 `HDU_SNIPER_IMAGE`（默认 `localhost/hdu-library-sniper:dev`）引用，`candidate-<revision>` tag 会被删除，悬空构建层也会清理，因此磁盘占用不会随更新次数持续增长。如果宿主机上还跑着其他 Podman 工作负载、不希望执行全局悬空镜像清理，可以在 `/etc/default/hdu-library-sniper-auto-update` 中加入：

```bash
HDU_SNIPER_PRUNE_IMAGES=0
```

此时脚本仍会删除候选 tag，但不会执行 `podman image prune`。查看占用与回收存量镜像：

```bash
podman system df
podman images -f reference='localhost/hdu-library-sniper:*'
```

生产数据继续保存在 `hdu-sniper-data` 命名卷中，不会因更新删除。自动更新配置位于：

```text
/etc/default/hdu-library-sniper-auto-update
```

默认配置跟踪当前仓库的 `origin/main`，也可以编辑该文件修改 `HDU_SNIPER_REMOTE`、`HDU_SNIPER_BRANCH`、镜像名或端口。建议将仓库 remote 指向可信地址，并通过受保护的主分支发布更新。

查看状态或手动执行一次检查：

```bash
sudo bun run podman:auto-update:status
sudo bun run podman:auto-update
```

卸载自动更新（不会删除应用容器或数据）：

```bash
sudo bun run podman:auto-update:uninstall
```

容器 WebUI 是单租户管理界面，不建议直接暴露到公网。请放在可信内网或已认证的反向代理之后。
