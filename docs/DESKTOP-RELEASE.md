# 桌面应用发布

## 更新检查

桌面应用进入主界面后，会在后台检查 GitHub Releases 的最新版本。发现新版本时，窗口顶部会出现更新图标；点击“下载更新”后，Windows 桌面版会在应用内下载安装包并显示进度，下载完成后用 GitHub Release 资产提供的 SHA-256 校验文件，通过后启动 Inno Setup 安装器并自动退出当前应用，安装完成后自动打开新版本。Web 模式或非 Windows 环境会退回浏览器打开下载页。

更新检查地址默认为：

`https://api.github.com/repos/AlaIchhe/HDU-Library-Sniper/releases/latest`

如需改用镜像或自建更新服务，可通过 `HDU_UPDATE_API_URL` 环境变量覆盖。更新检查是尽力而为的：网络不可用时不会影响登录、预约和调度功能。

版本号同时维护在 `pyproject.toml`、`src/hdu_sniper/__init__.py` 和 `uv.lock` 中。推荐用脚本统一更新，避免漏改：

```powershell
scripts\bump-version.ps1 1.4.0 -Commit -Tag -Push
```

参数说明：

- `-Commit`：自动提交版本号变更
- `-Tag`：自动创建 `v1.4.0` 标签（未指定 `-Commit` 时会自动提交）
- `-Push`：推送提交和标签，推送 `v*` 标签会触发发布工作流
- `-Title`：自定义 Release 标题；不带时默认使用标签名（如 `v1.4.0`）
- `-DeleteNotesFile`：配合 `-NotesFile` 使用，`git push` 成功后自动删除未跟踪的说明草稿（已跟踪文件会跳过）

也可以先不带参数运行，只修改本地文件并预览改动（`-DryRun`）。构建脚本和发布工作流会校验三处版本号及标签一致，不一致时直接构建失败。

### Release 描述

Release 描述默认由 GitHub 根据提交自动生成。如果想写自定义发布说明，可以在打标签时把说明写进标签消息，发布时会自动作为描述的开头，自动生成的更新日志会跟在后面：

```powershell
scripts\bump-version.ps1 1.4.0 -Commit -Tag -Push -NotesFile RELEASE_NOTES.md -DeleteNotesFile -Title "v1.4.0：新增自动签到"
```

也可以直接传文本（多行文本用 PowerShell 反引号 `` `n `` 换行）：

```powershell
scripts\bump-version.ps1 1.4.0 -Commit -Tag -Push -Notes "新功能：支持自动签到`n修复：预约时间校验"
```

不带 `-Notes` / `-NotesFile` 时，Release 描述就是 GitHub 自动生成的内容，不受影响。

使用 `-NotesFile` 时草稿默认保留；加上 `-DeleteNotesFile` 会在推送成功后自动删除未跟踪草稿，避免工作区残留未跟踪文件。

Release 标题默认是标签名（`v1.4.0`）；需要更详细的标题时用 `-Title` 指定，标题会与发布说明一起写入标签并自动应用到 Release。

### 用 AI 生成发布说明

每次发布前可把下面这句话提示词交给 Codex 或其他 AI，它会自动找出自上次发布以来的提交并生成说明（无需手动指定版本号，可重复使用）：

> 请先运行 `git log --no-merges --format='%s' $(git describe --tags --abbrev=0)..HEAD` 查看自上次发布以来的全部提交，然后用中文为即将发布的下一版本写一份面向用户的 GitHub Release 发布说明，按“新功能 / 改进 / 修复”分类，语言简洁，不包含提交哈希或内部实现细节。

把生成的文本保存到文件后，用 `-NotesFile` 传给发布脚本即可（发布时加 `-DeleteNotesFile` 可自动清理草稿）。

桌面版本包含 Python 运行时和项目依赖。最终用户不需要安装 Python 或运行命令。

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

## HTTP 登录

桌面版和 Docker 镜像都使用 SSO HTTP 直连登录，不再打包 Chromium/Playwright。
发布前可以用 `scripts/verify-http-login.py` 配合真实凭据验证登录链路：

```powershell
$env:HDU_STUDENT_ID="学号"; $env:HDU_PASSWORD="密码"; python scripts/verify-http-login.py
```

## 自动发布

推送 `v*` 标签会触发 `.github/workflows/desktop-release.yml`，分别在 Windows 和 macOS runner 上构建产物并创建 GitHub Release。手动触发 workflow 时只上传 Actions artifacts，不创建 Release。
