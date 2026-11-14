# macOS 版（未公证发行）

[返回项目首页](../README.md) · [开发与发布](DEVELOPMENT.md)

项目没有 Apple Developer Program 会员（99 美元/年），所以 macOS 版走的是**ad-hoc 签名 + 不公证**的发行路线。
本文说明这条路能做到什么、用户会遇到什么、以及以后买了会员要怎么切。

## 为什么只能这样

macOS 的 Gatekeeper 只认两样东西：**Developer ID 证书签名**和**Apple 公证（notarization）**。
两者都要付费会员：Developer ID Application 证书只有会员账号的 Account Holder 能签发，公证接口同样要会员凭证。
Tauri 官方文档也写明「免费账号可以签名但不能公证，应用仍会显示为未验证」。
所以「双击直接打开、没有任何提示」这件事，在没有会员的情况下做不到——这是 Apple 的规则，不是实现问题。

能做的底线是 **ad-hoc 签名**（`signingIdentity: "-"`，即 `codesign -s -`）：

- Apple Silicon 上的 arm64 二进制**必须**有代码签名才允许执行，不签会直接报「应用已损坏」；
- ad-hoc 签名让应用能跑起来，但 Gatekeeper 依然会拦「无法验证开发者」，需要用户手动放行。

## 用户怎么装

1. 下载 `HDU Library Sniper_<版本>_universal.dmg`，打开后把应用拖进「应用程序」。
2. 双击打开，系统提示「无法打开，因为无法验证开发者」。
3. 打开 **系统设置 → 隐私与安全性**，在「安全性」区域点 **仍要打开**，再输入密码确认。

> [!IMPORTANT]
> macOS 15 Sequoia 起，Finder 里「右键 → 打开」的绕过方式已经被 Apple 移除，
> 只能走上面第 3 步的系统设置入口。

也可以用终端一次性去掉隔离属性（等价于上面的放行）：

```bash
xattr -dr com.apple.quarantine "/Applications/HDU Library Sniper.app"
```

## 已知限制

- **钥匙串授权可能每次更新都重来。** ad-hoc 签名是对二进制内容算的哈希，每个版本都不一样，
  系统看到的「同一个应用」的身份就变了，钥匙串项的访问授权可能重新弹窗，甚至读不到旧条目。
  如果这个体验不能接受，可以自己签一张**自签名证书**（Keychain Access → 证书助理，免费），
  把它的名字写进 `bundle.macOS.signingIdentity` 并在 CI 里导入。它同样不被 Apple 信任、照样要用户放行，
  但签名身份稳定，钥匙串授权和通知授权不会每次重来。
- **通知权限**：首次运行会请求，和是否公证无关；授权后通知走系统通知中心。
- **自动更新**：更新包用项目自己的 minisign 密钥签名（和 Apple 证书无关），
  应用内下载的文件不带 quarantine 属性，一般不会被 Gatekeeper 拦。
  但更新后仍是 ad-hoc 签名，钥匙串那条限制依然存在。
- **自动启动**：macOS 没有安装器可以写启动项，应用首次运行时会自己注册 LaunchAgent
  （`~/Library/LaunchAgents/`，登录时以 `--background` 启动），对应 Windows 上 NSIS 钩子写的 `HKCU\...\Run`。

## 构建与发版

macOS 二进制只能在 macOS 上构建（需要 Xcode 命令行工具），本仓库用 GitHub Actions 的 `macos-latest` runner，
公共仓库免费。工作流见 [`.github/workflows/release-macos.yml`](../.github/workflows/release-macos.yml)：

```bash
bun run tauri build --target universal-apple-darwin --bundles app,dmg
```

产物：

```text
src-tauri/target/universal-apple-darwin/release/bundle/dmg/HDU Library Sniper_<版本>_universal.dmg
src-tauri/target/universal-apple-darwin/release/bundle/macos/HDU Library Sniper.app.tar.gz     # 更新包
src-tauri/target/universal-apple-darwin/release/bundle/macos/HDU Library Sniper.app.tar.gz.sig # 更新签名
```

`latest.json` 由 Windows 任务生成，macOS 任务用
[`scripts/patch-latest-json.py`](../scripts/patch-latest-json.py) 补上 `darwin-aarch64` / `darwin-x86_64`
两个平台键（universal 包两边通用）。

## 买了会员之后要改什么

1. 在 Apple Developer 后台建 **Developer ID Application** 证书，导出 `.p12`。
2. 往仓库 Secrets 里加 `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`。
3. 工作流里导入证书（`security import`），把 `bundle.macOS.signingIdentity` 从 `"-"` 换成证书名。
4. 打开公证：tauri-action 会用 `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` 自动提交公证。
5. 之后用户下载双击即可直接打开，上面「用户怎么装」整节可以删掉。

## 功能适配状态

| 能力 | Windows | macOS | 说明 |
| --- | --- | --- | --- |
| 安装包 | NSIS（perMachine） | DMG + `.app` | `--bundles app,dmg` |
| 自启动 | NSIS 钩子写 `HKCU\...\Run` | LaunchAgent（`tauri-plugin-autostart`） | 首次运行自动注册 |
| 凭据加密 | Windows 凭据管理器 | 登录钥匙串（`keyring` 的 `apple-native`） | 都走 AES-256-GCM，密钥存系统钥匙串 |
| 系统通知 | 插件 | 插件（需授权） | 前端已处理 `requestPermission` |
| 自动更新 | `latest.json` / `windows-x86_64` | `latest.json` / `darwin-*` | 共用 minisign 密钥 |
| 单实例 | 插件 | 插件 | 同代码 |
| 签名 | 无（可选签） | ad-hoc（`-`） | 见上文 |
| 公证 | 不适用 | **无**（需要会员） | 用户手动放行 |

## 测试

这台 Linux 主机**不能**构建或验证 macOS 产物：没有 Xcode/SDK，`dockur/macos` 也不适用
（要求 AVX2，本机 N5105 没有；非 Apple 硬件跑 macOS 违反 EULA）。

可行的验证方式：

- **CI**：`macos-latest` runner 上跑完整构建，`codesign -dv` 检查签名状态；
- **真机**：任意一台 Mac（甚至朋友的）上装一遍，确认放行流程、钥匙串弹窗、通知、LaunchAgent 都在位；
- 交叉类型检查在本机也做不了（`ring` 需要 `-arch arm64` 的 clang 交叉编译），所以 macOS 分支的编译由 CI 把关。
