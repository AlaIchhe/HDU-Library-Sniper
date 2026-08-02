# 桌面应用发布

## 更新检查

桌面应用进入主界面后，会在后台检查 GitHub Releases 的最新版本。发现新版本时，窗口顶部会出现更新图标；点击后会打开当前平台对应的安装包下载地址。

更新检查地址默认为：

`https://api.github.com/repos/AlaIchhe/HDU-Library-Sniper/releases/latest`

如需改用镜像或自建更新服务，可通过 `HDU_UPDATE_API_URL` 环境变量覆盖。更新检查是尽力而为的：网络不可用时不会影响登录、预约和调度功能。

每次发布前需要同步更新 `pyproject.toml` 和 `src/hdu_sniper/__init__.py` 中的版本号，然后推送 `v*` 标签触发发布工作流。构建脚本和发布工作流会校验三者一致，不一致时直接构建失败。

桌面版本包含 Python 运行时、项目依赖和 Chromium。最终用户不需要安装 Python、运行命令或下载浏览器。

## Windows

构建要求：Windows 10/11 x64、`uv` 和 Inno Setup 6。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\Build-Windows.ps1
```

输出：

- `dist/HDU-Library-Sniper-Setup-<version>.exe`：面向用户的安装程序。
- `dist/HDU-Library-Sniper-<version>-windows-x64-portable.zip`：免安装版本。

安装程序按当前用户安装到 `%LOCALAPPDATA%\Programs\HDU Library Sniper`，创建开始菜单入口并支持标准卸载，不需要管理员权限。

没有 Inno Setup 时可执行：

```powershell
scripts\Build-Windows.ps1 -SkipInstaller
```

这仍会构建可直接双击运行的便携版 EXE。

### Windows 签名

代码签名证书已导入当前用户证书库并安装 Windows SDK `signtool.exe` 后：

```powershell
scripts\Build-Windows.ps1 -CertificateSha1 "CERTIFICATE_SHA1"
```

脚本会同时签名主程序和安装器，并使用 SHA-256 时间戳。未签名版本可以运行，但可能出现 SmartScreen 警告。

## macOS

macOS 应用必须在 macOS 主机上构建：

```bash
bash scripts/build-macos.sh
```

输出为 `dist/HDU-Library-Sniper-<version>-macos.dmg`。设置 `MACOS_CODESIGN_IDENTITY` 后，构建脚本会将签名身份传给 Flet/PyInstaller：

```bash
MACOS_CODESIGN_IDENTITY="Developer ID Application: ..." bash scripts/build-macos.sh
```

面向外部用户发布时，还需要使用 Apple Developer ID 完成签名和 notarization，否则 Gatekeeper 会显示未验证开发者提示。

## 内置浏览器

两个桌面构建脚本都会把 Playwright Chromium headless shell 下载到临时构建目录并作为应用资源打包。桌面登录不需要完整浏览器 UI；运行时通过冻结应用资源根目录定位 headless shell，因此用户无需执行 `playwright install`。Docker 镜像仍在镜像构建阶段安装自己的 Chromium，不共享桌面资源。

## 自动发布

推送 `v*` 标签会触发 `.github/workflows/desktop-release.yml`，分别在 Windows 和 macOS runner 上构建产物并创建 GitHub Release。手动触发 workflow 时只上传 Actions artifacts，不创建 Release。
