# 开发与发布

[返回项目首页](../README.md) · [部署说明](DEPLOYMENT.md)

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

## 日志

桌面端有两份日志，都在用户目录下：

```text
%USERPROFILE%\.hdu-library-sniper\logs\server.log            后端 Bun 服务的 stdout/stderr
%LOCALAPPDATA%\io.github.alaichhe.hdu-library-sniper\logs\hdu-library-sniper.log   Tauri 与前端日志
```

后端输出由 Tauri 启动时重定向到文件，超过 5 MiB 轮转为 `server.log.1`；设置 `HDU_SNIPER_HOME` 时日志目录跟着该变量走。GUI 日志按 500 KB 轮转并保留全部历史，轮转文件名里的时间是 UTC。

## 自动更新与发布

自动更新读取：

```text
https://github.com/AlaIchhe/HDU-Library-Sniper/releases/latest/download/latest.json
```

发布前只需在 GitHub Actions Secrets 配置：

- `TAURI_SIGNING_PRIVATE_KEY`：完整的 Tauri updater 私钥
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码

公钥是非敏感信息，已写入 `src-tauri/tauri.conf.json`。私钥只应保存在 GitHub Actions Secret，不能提交到仓库。

发布前先将 [README](../README.md) 中 MSI 下载链接的版本号改为本次发布版本号，再推送 `v*` 标签（将下方 `X.Y.Z` 替换为实际版本号）：

```powershell
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
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
