# Windows 安装测试（MyGo v3 NSIS 安装包）

用 [`dockur/windows`](https://github.com/dockur/windows) 在一台 Linux 主机上跑一台真正的 Windows 11，
把本地 `bun run build -- -platform windows/amd64` 或 Release 里的 `hdu-library-sniper-setup-*-amd64.exe` 装一遍，验证 CI 测不到的 Windows 桌面行为：

- per-user 安装到 `%LOCALAPPDATA%\Programs\HDU Library Sniper`
- 卸载信息写进 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\io.github.alaichhe.hdu-library-sniper`
- 首次启动由 MyGo 写入自启动 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\io.github.alaichhe.hdu-library-sniper`（`--mygo-opened-at-login`）
- 覆盖安装时用户数据（`%APPDATA%\HDU Library Sniper\data\sniper.db`）保留
- WebView2 窗口渲染（`DesktopAPI.Ready` / `DesktopAPI.Request` 内存 IPC，不监听本地 HTTP 端口）、托盘和单实例锁
- 开始菜单快捷方式落盘与卸载后清理（文件、注册表、Run 自启动项、快捷方式、进程）

## 环境要求

- Linux + KVM（`/dev/kvm` 可读写）
- Podman 或 Docker
- 约 12 GB 磁盘（Windows ISO + 系统盘），6 GB 可用内存给虚拟机

## 用法

```bash
# 本地打包 Windows 安装包（需安装 makensis），run.sh 会优先拷贝 build/windows-amd64/*-setup-*.exe
bun run build -- -platform windows/amd64

./windows-test/run.sh start     # 首次：自动装 Windows 11，登录后通过 RunOnce 跑 verify.ps1
./windows-test/run.sh logs      # 跟着看进度（也可用浏览器打开 http://127.0.0.1:8006）
./windows-test/run.sh status
./windows-test/run.sh stop      # 优雅关机（ACPI）
./windows-test/run.sh destroy   # 删掉系统盘，下次 start 重装 Windows
```

如果未先本地构建，`run.sh` 会自动从 GitHub Latest Release 拉取 `*-setup-*-amd64.exe` 到 `windows-test/oem/setup.exe`。

## 自动化链路

```
容器 /oem  ──烘进安装介质──▶  C:\OEM\
                               ├─ install.bat     ← SetupComplete.cmd 以 SYSTEM 执行
                               ├─ verify.ps1      ← 注册到 RunOnce（交互式用户会话）
                               └─ setup.exe
```

- `oem/verify.ps1` 会检查安装、快捷方式、卸载项、`--background` 启动、SQLite 落盘、首次启动自启动注册、单实例锁、覆盖安装数据保留及完整卸载，并把 `report.json` / `verify.log` / 截图写回 `windows-test/shared/results/`。
- `-Watch` 模式常驻轮询 `Z:\jobs`，可将 `scripts/first-launch-test.ps1` 等脚本直接丢进 `windows-test/shared/jobs/` 执行，无需重装 Windows。
- `vmctl.py` 可通过 QEMU HMP monitor（`/run/shm/monitor.sock`）在不连接 RDP/VNC 的情况下截屏与发送按键。
