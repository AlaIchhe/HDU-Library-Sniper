# Windows 安装测试（真实 NSIS 安装）

用 [`dockur/windows`](https://github.com/dockur/windows) 在一台 Linux 主机上跑一台真正的 Windows 11，
把 Release 里的 `*-setup.exe` 真的装一遍。Linux CI 能测代码，测不了这些：

- `perMachine` 安装到 `C:\Program Files`，需要管理员令牌
- NSIS 钩子 `taskkill` + `msiexec /x{5839189D-…}` 的旧 MSI 迁移路径
- 卸载信息写进 `HKLM\...\Uninstall`，自启动写进 `HKCU\...\Run`
- 覆盖安装时用户数据（`%USERPROFILE%\.hdu-library-sniper`）不丢
- WebView2 运行时是否存在、Tauri 窗口能不能起来、托盘和单实例插件行为
- 桌面 / 开始菜单快捷方式落在 `SetShellVarContext all` 的机器级目录
- 卸载后残留（进程、文件、注册表、快捷方式）

## 环境要求

- Linux + KVM（`/dev/kvm` 可读写）
- Podman（本仓库已在 rootful podman 5.4.2 上验证）或 Docker
- 约 12 GB 磁盘（8 GB ISO + 系统盘增长），6 GB 可用内存给虚拟机

本机实测：Debian 13 / Intel Celeron N5105（4 核，无 AVX2）/ 16 GB 内存 / 143 GB 可用。

## 用法

```bash
# 第一次准备 ISO（宿主侧下载比容器内快得多，且 destroy 重装不用再下）
curl -L -C - -o windows-test/win11.iso "$MS_WIN11_ISO_URL"

./windows-test/run.sh start     # 首次：自动装 Windows，约 15–25 分钟
./windows-test/run.sh logs      # 跟着看进度（也可用浏览器打开 http://127.0.0.1:8006）
./windows-test/run.sh status
./windows-test/run.sh stop      # 优雅关机（ACPI）
./windows-test/run.sh destroy   # 删掉系统盘，下次 start 重装 Windows
```

`oem/setup.exe` 是 release 资产 `HDU.Library.Sniper_2.1.5_x64-setup.exe` 的副本
（sha256 `1888db247b17025af2f970f912fe7dad72e80333c03ccd3ff7ba5f563be5925b`）。
换版本只要覆盖它，`run.sh destroy` 后重来。

## 自动化链路

```
容器 /oem  ──烘进安装介质──▶  C:\OEM\
                               ├─ install.bat     ← SetupComplete.cmd 以 SYSTEM 执行
                               ├─ verify.ps1
                               └─ setup.exe

install.bat       注册 HKLM\...\RunOnce：登录后在用户会话里跑 verify.ps1 -Watch
verify.ps1        ① 跑一整套安装/启动/覆盖/卸载检查 → ② 常驻轮询 Z:\jobs
```

为什么不用计划任务：`schtasks /create /ru <user> /rp <pass>` 建出来的是「不管用户是否登录都运行」的任务，
触发后会落在 session 0，没有桌面、没有映射的 `Z:`，截图和 GUI 启动都做不了。RunOnce 在交互式会话里跑，
而且这台 unattended 安装出来的机器关掉了 UAC，直接就是完整令牌。

脚本结尾的 `-Watch` 让进程常驻并每 3 秒轮询 `Z:\jobs`，后续验证不需要重装 Windows。

## 实测结果

2026-11-14，Windows 11 Pro 25H2（build 26200），2 vCPU / 6 GB，release 2.1.5：

```
21 passed, 0 failed   (49.7s)
```

证据在 [`evidence/2026-11-14-win11-25h2/`](evidence/2026-11-14-win11-25h2)：
`report.json`、`verify.log`、安装后与卸载后的桌面截图。

整条自动链路也验证过一次：在 guest 里写好 `RunOnce` 后重启，Windows 自动登录 → RunOnce 拉起
`verify.ps1` → 套件跑完 → 结果回传到 `Z:`，见同目录的 `boot-run.log`（那次镜像是旧版脚本，
18 项检查；21 项的版本是随后从控制台直接跑的）。

其中几个只有真机能看到的结论：

- 静默安装 `setup.exe /S` 10.6 s 完成，退出码 0，落盘到 `C:\Program Files\HDU Library Sniper`
- 卸载项：`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\HDU Library Sniper`，`DisplayVersion=2.1.5`
- 自启动：`HKCU\...\Run\HDU-Library-Sniper = "C:\Program Files\HDU Library Sniper\hdu-library-sniper.exe" --background`
- 快捷方式在 `C:\Users\Public\Desktop` 和 `C:\ProgramData\Microsoft\Windows\Start Menu\Programs`
  （perMachine 安装用了 `SetShellVarContext all`，不在用户目录里）
- `--background` 启动后进程常驻，`127.0.0.1:8000/api/health` 返回 200 `{"status":"ok"}`
- 数据落在 `%USERPROFILE%\.hdu-library-sniper\data\hdu-sniper.sqlite`，日志在
  `%LOCALAPPDATA%\io.github.alaichhe.hdu-library-sniper\logs`
- 第二次启动不会起第二个进程（single-instance 生效）
- 卸载后文件、卸载项、Run 键、两个快捷方式、进程全部清干净；用户数据目录保留（符合「凭据不清」的设计）

## 检查项

| id | 验证内容 |
| --- | --- |
| `baseline.clean` / `baseline.cleanup` | 起始状态干净；上一轮残留会先静默卸载 |
| `install.exit` | `/S` 静默安装退出码 0，并记录耗时 |
| `files.exe` / `files.version` / `files.uninstaller` | 主程序与卸载器落盘、版本信息正确 |
| `shortcut.desktop` / `shortcut.startmenu` | 用户目录或机器级目录里存在快捷方式 |
| `registry.uninstall` / `registry.installlocation` | 控制面板卸载项存在，`InstallLocation` 指向 Program Files |
| `registry.autostart` | `HKCU\...\Run` 值精确匹配 `"<exe>" --background` |
| `launch.survives` / `launch.health` | 进程 20 s 不退出；`127.0.0.1:8000/api/health` 返回 200 |
| `data.sqlite` / `data.logs` / `data.startup` | 数据目录、日志目录、启动日志生成 |
| `single-instance` | 再启动一次不会出现第二个进程 |
| `reinstall.data` / `reinstall.no-duplicate` | 覆盖安装不动用户数据、不产生重复卸载项 |
| `uninstall.*` / `shortcut.removed` | 文件、卸载项、自启动、快捷方式、进程都清干净 |
| `uninstall.userdata` | 用户数据目录是否保留（记录实际行为） |

## 重复跑

```bash
cat > windows-test/shared/jobs/smoke.ps1 <<'EOF'
& 'C:\OEM\setup.exe' /S
Get-Item 'C:\Program Files\HDU Library Sniper\hdu-library-sniper.exe' | Select-Object Length, LastWriteTime
EOF
```

常驻进程会执行并把输出写到 `windows-test/shared/results/jobs/smoke.out`。

## 已知坑

1. **同版本静默重装是 no-op。** 2.1.5 覆盖装 2.1.5 只花 3.3 s，文件、快捷方式都不重建
   （Tauri 的 NSIS 模板检测到同版本就直接退出）。所以「覆盖安装」要用 N-1 → N 升级来测，
   见下一节的 MSI 迁移脚本。
2. **宿主机往共享目录丢文件，Windows 侧可能几分钟看不到。** SMB2 目录租约缓存，
   `dir Z:\jobs` 会一直返回旧列表，直到 guest 自己在同一目录里写一次（脚本里每轮先写 `.tick` 打租约）。
   所以 jobs 通道适合「改完等着」，不适合秒级交互。
3. **这台无人值守安装关掉了 UAC**（`EnableLUA=0`）。perMachine 提权、Program Files 写入、
   HKLM/HKCU 落点都覆盖了，但「弹 UAC 对话框、用户点『是』」这一下没有覆盖。
4. 虚拟机时钟是 UTC-8，且 RTC 日期和宿主机差一天，结果目录名以 guest 时间为准。
5. 虚拟机在校园网外，登录 / 预约 / 签到走不通；这里只验证「装得上、起得来、退得干净」。

## 旧 MSI → 新 NSIS 的迁移测试

`NSIS_HOOK_PREINSTALL` 里那条 `msiexec /x{5839189D-…}` 是最容易出事、又最难在 Linux 上验证的一段。
把旧 MSI 一起烘进介质再跑脚本：

```bash
cp artifacts/HDU.Library.Sniper_2.0.33_x64_zh-CN.msi windows-test/oem/old-2.0.33.msi
# guest 里：
powershell -NoProfile -ExecutionPolicy Bypass -File C:\OEM\upgrade-from-msi.ps1
```

脚本会：装 2.0.33 MSI → 造一份 sqlite 用户数据 → 直接跑 2.1.5 `setup.exe /S` → 断言旧卸载项被清掉、
只剩 2.1.5、用户数据哈希不变、自启动存在、应用能起来。结果写到
`windows-test/shared/results/upgrade/`。

2026-11-14 已经用它查出并修掉一个真问题：hook 里写死的 ProductCode 和 `2.0.21 / 2.0.29 / 2.0.30 /
2.0.31 / 2.0.32 / 2.0.33` 六个真实发布过的 MSI **一个都对不上**，`msiexec /x` 一直返回 1605，
等于这条迁移从来没生效过。修法改成按卸载项枚举（`WindowsInstaller=1` 的键名就是 ProductCode），
并在真机上用发布的 2.0.33 MSI 验证过：旧条目和旧文件都被清掉了。
证据见 [`evidence/2026-11-14-legacy-msi-hook/`](evidence/2026-11-14-legacy-msi-hook)。

## 为什么没有 macOS

`dockur/macos` 对本项目目前没有可测对象，也不该在这台机器上跑：

- `src-tauri/tauri.conf.json` 的 `bundle.targets` 只有 `["nsis"]`，Release 只有 Windows 安装包，没有 `.dmg` / `.app` 可装。
- dockur/macos 要求 AVX2，这台 N5105（Jasper Lake）没有。
- 非 Apple 硬件安装 macOS 违反 Apple EULA，dockur 自己的 README 也写明只能在 Apple 硬件上运行。

真要做 macOS 覆盖，顺序应该是：先加 `dmg` 打包目标和 CI 矩阵，再谈运行环境。
