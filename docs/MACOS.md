# macOS 版（未公证发行）

[返回项目首页](../README.md) · [开发与发布](DEVELOPMENT.md)

项目默认没有 Apple Developer Program 会员（99 美元/年），所以 macOS 版走的是 **ad-hoc 签名（`-`）+ 不公证** 的发行路线。

## 用户怎么装

1. 从 Release 下载对应架构或通用 `.dmg`，打开后把 `HDU Library Sniper.app` 拖进「应用程序」。
2. 双击打开，如果系统提示「无法打开，因为无法验证开发者」，打开 **系统设置 → 隐私与安全性**，在「安全性」区域点 **仍要打开**。
3. 也可以在终端一次性去掉隔离属性：

```bash
xattr -dr com.apple.quarantine "/Applications/HDU Library Sniper.app"
```

## 平台集成机制

- **后端与数据库**：全程纯 Go（`CGO_ENABLED=0`），与 Windows/Linux/容器端共用同一套代码与 `modernc.org/sqlite`。
- **凭据加密**：统一使用 AES-256-GCM 加密后写入本地 SQLite，密钥来自 `HDU_SNIPER_SECRET_KEY` 或应用数据目录下的 `0600` 权限 `.secret.key`（不再依赖系统钥匙串授权弹窗）。
- **开机自启、系统托盘与通知**：通过 MyGo 原生桌面能力集成；在托盘菜单可直接切换「开机自启动」。
- **构建与发布**：由 [`.github/workflows/release.yml`](../.github/workflows/release.yml) 在 `macos-latest` 上通过 `bun run build -- -platform "darwin/arm64,darwin/amd64"` 构建。若配置 Apple Developer 签名与公证环境变量，可切换为正式签名发布。
