# HDU Library Sniper

杭州电子科技大学图书馆预约与自动签到工具。项目使用 Bun + TypeScript + React 构建 Web 工作台，并提供 Tauri v2 Windows 桌面端。

桌面端和容器端都由同一个本地后台服务负责预约、签到、审计和会话保持。登录凭据只提交给本机服务，不会上传到第三方服务器。

## 功能

- 登录杭电数字杭电账户，保存本地会话 Cookie
- 创建、启用和管理图书馆预约方案
- 按预约时间自动提交预约，并复核预约结果
- 在签到窗口自动签到，支持手动签到和结果复核
- 审计日志记录预约、签到及后台错误
- Windows 系统通知：预约完成、签到结果和后台错误
- Windows 开机自启：通过计划任务 `HDU-Library-Sniper` 启动后台模式
- Tauri 自动更新：从 GitHub Releases 检查并安装签名更新
- SQLite 本地持久化，容器部署使用命名卷保存数据

## 最新版本

Windows x64 MSI 安装包：

[下载 HDU Library Sniper](https://github.com/AlaIchhe/HDU-Library-Sniper/releases/latest/download/HDU.Library.Sniper_2.0.9_x64_zh-CN.msi)

## 使用说明

启动后，在登录页输入学号和数字杭电密码。进入工作台后创建预约方案，选择房间类型、校区、楼层、日期、时间段和座位规则，再启用方案即可。

Windows 桌面端安装完成后默认开启开机自启。应用顶部可以查询并切换自启状态。关闭窗口只会隐藏到系统托盘；从托盘选择退出时，后台服务会一并停止。

预约和签到结果会显示在工作台中。Windows 桌面端还会发送系统通知，浏览器开发模式不会调用系统通知 API。

## 开发环境

推荐环境：

- Bun 1.2+
- Windows 桌面端开发需要 Rust、Cargo 和 Visual Studio Build Tools（MSVC）
- 容器部署需要 Docker Compose 或 Podman Compose

安装依赖并启动 Vite 开发服务器：

```bash
bun install
bun run dev
```

浏览器开发模式需要同时启动后台服务：

```bash
bun run server:dev
```

后台默认监听 `http://localhost:8000`。生产模式构建并启动：

```bash
bun run build
bun run server
```

常用检查命令：

```bash
bun run typecheck
bun run test
bun run build
```

预约逻辑支持预演，不会真正提交预约请求：

```bash
bun run booking-run --dry-run
```

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

默认情况下 `podman:up` 还会安装宿主机 systemd 定时器 `hdu-library-sniper-booking.timer`，每天 20:00（Asia/Shanghai）执行一次预约任务。如不需要宿主机定时器：

```bash
HDU_SKIP_SYSTEMD_SCHEDULER=1 bun run podman:up
```

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
4. 健康检查通过后替换生产容器；
5. 替换失败时恢复旧容器。

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

## Windows MSI 安装

直接下载上方 MSI，双击安装即可（安装位置为 `Program Files`，首次安装可能需要管理员确认）。如果电脑上已经安装了旧的 MSI 版本，新版本会自动覆盖；如果旧版本来自更早的 Setup(`.exe`)/NSIS/Inno 安装包，MSI 安装时也会先将其卸载，避免新旧两套程序同时存在导致点开仍是旧版本。

安装完成后可在应用顶部切换“开启自启”。自启使用当前用户的启动项（`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`），以 `--background` 参数在登录时启动后台预约、签到和托盘服务。也可以用系统命令查看：

```powershell
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "HDU-Library-Sniper"
```

关闭主窗口不会停止任务；请从托盘菜单退出应用，或在设置中关闭自启后再卸载。

## Windows 本地构建

在 Windows 上安装 Rust/Cargo 和 Visual Studio Build Tools（勾选 Desktop development with C++），然后执行：

```powershell
bun install
bun run build:server
bun run tauri build --bundles msi
```

生成的 MSI 位于：

```text
src-tauri/target/release/bundle/msi/
```

项目只发布 MSI，不发布 NSIS 安装包。MSI 使用 WiX hook 在安装时先清理旧版安装、再覆盖新文件，避免新旧版本并存导致点开仍是旧版本。

## 自动更新与发布

自动更新读取：

```text
https://github.com/AlaIchhe/HDU-Library-Sniper/releases/latest/download/latest.json
```

发布前只需在 GitHub Actions Secrets 配置：

- `TAURI_SIGNING_PRIVATE_KEY`：完整的 Tauri updater 私钥
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码

公钥是非敏感信息，已写入 `src-tauri/tauri.conf.json`。私钥只应保存在 GitHub Actions Secret，不能提交到仓库。

正式发布版本时推送 `v*` 标签：

```powershell
git tag -a v2.0.9 -m "Release v2.0.9"
git push origin v2.0.9
```

`.github/workflows/release.yml` 会在 Windows runner 上完成依赖安装、Bun 后端编译、MSI 打包、签名并生成 `latest.json`。工作流会直接发布正式 Release，上传 MSI 后客户端即可通过 `releases/latest` 获取自动更新，无需再手动发布。

## 项目结构

```text
src/server/              Bun 后台服务、预约/签到调度和 API
src/web/                 React WebUI、通知和自动更新封装
src-tauri/               Tauri v2 桌面端、托盘、Windows 自启命令
src-tauri/wix-fragments/ MSI WiX 安装/卸载 hook
scripts/                 Podman 和 systemd 定时器脚本
tests/                   前端和服务测试
```

## 免责声明

本项目仅用于学习和个人效率工具开发。请遵守学校图书馆服务条款和相关法律法规，合理设置预约方案，不要频繁请求或影响他人正常使用。使用本项目产生的账号、预约和签到结果由使用者自行负责。

## License

详见 [LICENSE](LICENSE)。
