# 开发与发布

[返回项目首页](../README.md) · [部署说明](DEPLOYMENT.md) · [馆方限制实测](HUITU-LIMITS.md)

## 开发环境

推荐环境：

- Bun 1.2+（前端构建）
- Rust stable + Cargo
- Windows 桌面端开发需要 Visual Studio Build Tools（MSVC）和 WebView2
- 容器部署需要 Docker Compose 或 Podman Compose

安装依赖并启动 Vite 开发服务器：

```bash
bun install
bun run dev
```

浏览器开发模式需要同时启动 Rust 后台服务：

```bash
bun run server:dev
```

桌面端开发直接运行 Tauri，Rust server 会在 Tauri 进程内启动：

```bash
bun run tauri dev
```

后台默认监听 `http://localhost:8000`。生产模式构建并启动：

```bash
bun run build
bun run server
```

常用检查命令：

```bash
bun run typecheck      # TypeScript 类型检查
bun run lint           # Biome 静态检查（只读）
bun run format:check   # Biome 格式检查（只读）
bun run check          # lint + format，CI 用同一个入口
bun run test           # 前端单测
bun run build          # 前端构建
cargo test -p hdu-sniper-core -p hdu-sniper-hdu -p hdu-sniper-auth -p hdu-sniper-store -p hdu-sniper-server
cargo check -p hdu-library-sniper  # 桌面 Tauri 集成
```

需要自动修复时用 `bun run check:fix`（或 `lint:fix` / `format`）。
Biome 的配置在 `biome.jsonc`：2 空格缩进、双引号、行宽 110；
`src/web` 保持无分号风格，其余（server/tests）保留分号。

## Windows 本地构建

在 Windows 上安装 Rust/Cargo 和 Visual Studio Build Tools（勾选 Desktop development with C++），然后执行：

```powershell
bun install
bun run tauri build --bundles nsis
```

生成的 NSIS 安装包位于：

```text
target/release/bundle/nsis/
```

项目发布 NSIS 安装包（`*-setup.exe`），默认按 `perMachine` 安装到 Program Files。旧 MSI 用户首次安装新版时，NSIS hook 会先结束旧进程并卸载旧 MSI，保留用户数据；这次迁移会请求 UAC 管理员权限。

安装包的行为（Program Files 落盘、控制面板卸载项、`HKCU\...\Run` 自启动、覆盖安装保留用户数据、卸载残留）在 Linux 上测不到。
需要真机验证时，用仓库里的 [`windows-test/`](../windows-test/README.md)：它在支持 KVM 的 Linux 主机上用
`dockur/windows` 跑一台 Windows 11，把 release 的 `*-setup.exe` 自动安装、启动、覆盖安装、卸载一遍，
结果和截图回传到宿主机的 `windows-test/shared/results/`。

## macOS 构建

macOS 产物只能在 macOS 上构建（需要 Xcode 命令行工具），CI 用 GitHub Actions 的 `macos-latest`：

```bash
bun run tauri build --target universal-apple-darwin --bundles app,dmg
```

项目没有 Apple Developer Program 会员，发行走 ad-hoc 签名、不做公证，用户首次打开需要手动放行。
完整说明（用户安装步骤、钥匙串授权限制、买了会员之后怎么切）见 [MACOS.md](MACOS.md)。

## 日志

桌面端日志：

```text
%LOCALAPPDATA%\io.github.alaichhe.hdu-library-sniper\logs\hdu-library-sniper.log   Tauri 与前端日志
```

Rust 后端在 Tauri 进程内运行，不再有单独的 `server.log`。GUI 日志按 500 KB 轮转并保留全部历史，轮转文件名里的时间是 UTC。

## 自动更新与发布

自动更新读取：

```text
https://github.com/AlaIchhe/HDU-Library-Sniper/releases/latest/download/latest.json
```

发布前只需在 GitHub Actions Secrets 配置：

- `TAURI_SIGNING_PRIVATE_KEY`：完整的 Tauri updater 私钥
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码

公钥是非敏感信息，已写入 `src-tauri/tauri.conf.json`。私钥只应保存在 GitHub Actions Secret，不能提交到仓库。

发布前确认 [README](../README.md) 的下载入口可用，再推送 `v*` 标签（将下方 `X.Y.Z` 替换为实际版本号）：

```powershell
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

`.github/workflows/release.yml` 会在 Windows runner 上完成依赖安装、Rust 后端编译、NSIS 打包、签名并生成 `latest.json`。工作流会直接发布正式 Release，上传 `*-setup.exe` 后客户端即可通过 `releases/latest` 获取自动更新，无需再手动发布。

工作流最后会把 `latest.json` 里的 GitHub API 资产地址改写成 `releases/download` 的浏览器地址。前者受公开仓库 API 未认证限流影响，客户端下载时可能收到 403；后者不受这个限制。手动发布时也要保持同样的地址格式。

### 客户端更新流程

1. 开机启动（`--background`）后延迟 5 秒静默请求一次 `latest.json`，失败按 15 秒、60 秒各重试一次；全程不弹提示，失败只写 GUI 日志。
2. 检出更高版本时，顶栏出现「更新到 vX.Y.Z」控件；平时不渲染任何更新入口（设置菜单里也不再提供手动检查）。
3. 点击控件就地变成进度条：下载（15 分钟上限）→ 签名校验 → 交给 NSIS 安装。Windows 安装器会结束当前进程并重新拉起新版本，安装期间若弹出 UAC 需要允许。
4. 任一步失败都会退回「更新到 vX.Y.Z」并弹一次 toast，日志里留有完整原因。

## 项目结构

```text
crates/core/             领域类型、上海时区、plan validation
crates/hdu/              馆方 HTTP、Cookie、AES/MD5
crates/auth/             SSO/openid/QR 登录、会话
crates/store/            SQLite schema/CRUD
crates/server/           axum API、scheduler、booking
src/web/                 React WebUI、通知和自动更新封装
src-tauri/               Tauri v2 桌面端、托盘、进程内 Rust server
src-tauri/nsis/         NSIS 安装/卸载 hook
scripts/                 Podman 和 systemd 定时器脚本
tests/                   前端测试
Containerfile            Rust server + 静态前端容器镜像
compose.yaml             Docker Compose 编排
```