# HDU-Library-Sniper

> 杭州电子科技大学图书馆座位自动抢座工具。

支持**即时抢座**与**定时预约**两种模式，具备指数退避重试、登录态缓存、多方案容错、超时幂等确认等特性。

---

## ✨ 功能特性

| 特性 | 说明 |
| --- | --- |
| ⚡ 即时抢座 | 立即尝试预约，按方案优先级逐个尝试，任一成功即停止 |
| 🕗 定时预约 | 设定目标时间（如 `07:00:00`），程序自动等待到点后发起抢占 |
| 🔁 智能重试 | 指数退避 + 随机抖动，对"预约窗口未开放"独立轮询（不占用重试预算） |
| 🛡️ 超时幂等确认 | 抢座请求响应超时时自动查询今日预约列表做服务端确认，避免成功却误报失败 |
| 🔐 账号密码登录 | 学号 + 数字杭电密码 headless 自动登录，无需扫码 / 手动复制 Cookie |
| 🍪 登录态缓存 | 登录一次后复用 cookie，过期自动用学号+密码 headless 续登 |
| 📦 多方案容错 | 支持配置多个房间/座位方案，主方案失败自动切备选 |
| 📨 通知推送 | 控制台 + 本地日志文件 + 微信 webhook（Server酱 / PushPlus 等） |

---

## 🚀 快速开始

### 环境要求

- Python 3.10+
- 依赖：`requests`、`pyyaml`、`playwright`（使用 `pip install -r requirements.txt` 安装）
- 浏览器二进制：`playwright install chromium`（headless 登录用，约 150MB，仅首次）

### 安装

```bash
git clone https://github.com/AlaIchhe/HDU-Library-Sniper.git
cd HDU-Library-Sniper
pip install -r requirements.txt
playwright install chromium
```

### 登录验证

首次运行需要登录：

```bash
python main.py
```

程序检测到没有有效登录态缓存时，会提示输入**学号**与**数字杭电密码**（密码不回显），随后在后台
静默启动 headless 浏览器，走杭电统一身份认证（`sso.hdu.edu.cn`）完成登录，自动导出登录态写入
`data/session.cache`。后续运行自动复用缓存，无需重复登录。

凭据会保存到 `data/credentials.yaml`（已 gitignore），供 `--run-now` 定时任务在 cookie 过期时
自动续登。可随时在菜单选「重新登录」更换密码。

> 登录依赖 Playwright（headless 浏览器，已含在 requirements.txt）：
>
> ```bash
> pip install -r requirements.txt   # 含 playwright
> playwright install chromium       # 下载浏览器二进制（约 150MB，仅首次）
> ```
>
> 登录态失效（退出码 2）时重跑 `python main.py` 会用保存的学号+密码自动续登。
> 无桌面环境（SSH / Linux 服务器 / SYSTEM 计划任务）也能 headless 登录，只要已 `playwright install chromium`；
> 实在无法装浏览器时，可把别处生成的 `data/session.cache` + `data/credentials.yaml` 拷贝过去。

### 添加预约方案

选择「添加方案」，按提示输入：
- 房间类型（1=自习室 / 2=教师休息室 / 3=阅览室 / 4=讨论室）
- 楼层 ID、座位号
- 开始时间（小时，如 `9` 表示 09:00）
- 自习时长（小时）
- 预约哪天的（0=今天，1=明天 …）

### 启动抢座

```bash
python main.py                  # 交互式：选择「开始抢座」或「定时预约」
python main.py --run-now        # 非交互模式，可配合 Windows 任务计划程序使用
```

`--run-now` 退出码：

| 退出码 | 含义 |
| --- | --- |
| 0 | 至少一个方案成功 |
| 1 | 全部方案失败 |
| 2 | 登录态过期且凭据续登失败 |
| 3 | 没有启用的方案 |

### 每日自动执行

项目不提供内置定时器，而是通过 [--run-now](#--run-now-退出码) 与操作系统调度器对接，单日单进程跑完即退出。并提供两个平台各自的 **自动注册脚本** —— 均自动探测项目目录与 Python 解释器路径,**无需手动拼装任何绝对路径**：

| 平台 | 注册方式 | 触发时刻 | 最小权限 | 睡眠能否触发 |
| --- | --- | --- | --- | --- |
| ✅ Windows | `scripts/AutoSchedule.ps1`(右键"使用 PowerShell 运行") | 每日 `19:59:59` | 管理员 | 默认唤醒(`-WakeToRun`),可在注册前 `$env:SNIPER_WAKE_TO_RUN="false"` 关闭 |
| ✅ Ubuntu | `bash scripts/setup.sh`(有 cron 用 cron,**无 cron/无 root 自动回退常驻循环**) | 每日 `19:59:59`(CST) | 当前用户 | 依赖物理开机,见 [彻底关机说明](#关于电脑关机与彻底断电) |

#### ✅ Windows:自动注册(任务计划程序)—— 开箱即用

仓库 `scripts/` 目录提供 `scripts/AutoSchedule.ps1` —— 把**项目根目录**作为工作目录,**优先锁定本地** `pythonw.exe`,以绝对路径写入 Action,注册一个每日 `19:59:59` 触发的计划任务 (`NT AUTHORITY\SYSTEM`,**不管用户是否登录都运行**)。找不到 pythonw.exe 会立即报错(退出码 7),避免静默失败。

注册成功后可在"任务计划程序库"找到 `HDU-Library-Sniper-Daily`,右键 → "运行"手动验证一次。

#### ✅ Ubuntu / Linux:自动注册 —— 一条命令完成(有 cron 用 cron,无 cron 自动回退常驻循环)

仓库提供 `scripts/setup.sh`,**一条命令、零交互**把系统依赖、miniconda、Python 包、调度任务全自动配好,缺什么补什么,全程不向用户确认:

```bash
bash scripts/setup.sh
```

`setup.sh` 全自动:

- **自动检测并安装系统依赖**(`curl` / `wget` / `crontab`):按 apt / yum / dnf / pacman / brew 自动识别包管理器,缺什么装什么;用 `sudo -n` 非交互安装,**无免密 sudo 时立即失败不卡密码提示**,仅警告后继续
- **自动探测 / 安装 Miniconda3**:按 `项目内 miniconda3` → `~/miniconda3` → PATH 中的 `conda` 顺序探测,缺则从官方镜像静默安装到 `~/miniconda3`
- **自动检查并仅补装缺失的 Python 包**:用 `pip install --dry-run` 探测待装项,已满足的跳过不重装(老版本 pip 不支持 dry-run 时退化为幂等 `pip install -r`)
- **`main.py` 语法校验** —— 失败立即退出,避免注册后静默失败
- **自动选择调度方式**(见下):有 cron 服务 → crontab;无 cron / 无 root → 纯用户态常驻循环
- **幂等安全**:重复运行 `setup.sh` 不会产生重复条目,也不会重复安装已存在的依赖
- **防并发**:`run_libsniper.sh` 通过 `/tmp/libsniper.lock` 互斥,同一分钟只跑一个实例
- **用户级**:写入**当前用户** crontab 或 `~/.bashrc`,**全程无需 root**

##### 调度方式:crontab 模式 vs 循环模式(自动二选一)

`setup.sh` 在注册阶段探测 cron 服务是否可用,自动选择:

| 模式 | 触发条件 | 实现 | 登出存活 | 重启存活 |
| --- | --- | --- | --- | --- |
| **crontab** | `crontab` 可用 **且** cron 服务在跑(`systemctl is-active cron` 或 `pgrep cron`) | 注册 `59 19 * * * sleep 59 && ... run_libsniper.sh` | ✅ cron 守护 | ✅ cron 开机自启 |
| **循环(loop)** | 上面条件不满足(无 cron / 无 root / 服务未启) | `scripts/loop_sniper.sh` 用 `setsid`+`nohup` 后台常驻,`sleep` 到下一个目标时刻再跑,跑完重新计算 | ✅ `setsid` 脱离终端 | ⚠️ 需登录一次触发 `~/.bashrc` 守卫自愈(见下) |

**循环模式生存保证**:

- **SSH 登出不中断**:`setsid` 把进程脱离控制终端,不受 SIGHUP 影响;日志写 `logs/loop.log`
- **服务器重启自愈**:`setup.sh` 在 `~/.bashrc` 写入一段守卫(用 `# >>> libsniper loop begin >>>` 标记块包裹,幂等),**重启后你首次登录**时守卫检测到循环没在跑就自动拉起。若服务器 24h 在线不重启,循环本身常驻即可
- **不会重复拉起**:循环启动有 `/tmp/libsniper_loop.lock` + `pgrep` 双重互斥,`.bashrc` 守卫也先 `pgrep` 判重

> 两种模式都从 `<checkout>/.libsniper.env` 读取部署时冻结的 `SNIPER_DAILY_AT` / `CONDA_ENV` / `TZ` / `LOG_DIR`,因此 `.bashrc` 守卫重新拉起循环时仍用你部署时设定的时刻,无需在 `.bashrc` 里重复配。

##### Ubuntu 路径约定(全部自推导,禁止手动拼路径)

| 项 | 缺省逻辑 |
| --- | --- |
| `APP_DIR`(即 `main.py` 所在目录) | `run_libsniper.sh` 所在目录的上一级,即项目 checkout 根 |
| `CONDA_ROOT` | 按优先级自动探测:项目内 `miniconda3/` → 项目内 `miniconda/` → `~/miniconda3` → `~/miniconda` → PATH 中的 `conda` |
| Python 解释器 | base 环境;设 `CONDA_ENV` 环境变量则切到 `$CONDA_ROOT/envs/$CONDA_ENV/bin/python` |
| 日志目录 | `logs/`,归档为 `libsniper_*.log`,保留最近 30 天 |

##### Ubuntu 自定义(环境变量覆盖)

| 环境变量 | 作用 | 缺省值 |
| --- | --- | --- |
| `CONDA_ENV` | 指定 conda 环境名 | `base`(使用 base 环境的 python) |
| `LOG_DIR` | 自定义日志目录 | `<checkout>/logs` |
| `TZ` | 自定义时区 | `Asia/Shanghai` |
| `SNIPER_DAILY_AT` | 自定义触发时刻(格式 `HH:MM:SS` 或 `HH:MM`) | `19:59:59` |

> **实现原理**:crontab 的最小粒度是分钟,因此 `setup.sh` 会把目标时刻拆成「整分钟触发 + 命令内 `sleep N 秒`」两步走。例:`07:15:30` 会被注册为 `15 7 * * * sleep 30 && ...`,**秒级误差 <50ms**。
>
> **设置示例**:
>
> ```bash
> # 用已有的 conda env "snipe" 抢
> CONDA_ENV=snipe bash scripts/setup.sh
>
> # 自定义触发时刻:每晨 07:15:30 抢
> SNIPER_DAILY_AT=07:15:30 bash scripts/setup.sh
>
> # 永久生效(写入 ~/.profile,所有新 cron 注册沿用)
> echo 'export SNIPER_DAILY_AT=07:15:30' >> ~/.profile
> source ~/.profile
> ```

##### Ubuntu 常用维护命令

```bash
bash scripts/setup.sh                 # 首次部署 / 重新部署(幂等,自动选 crontab 或 loop)
bash scripts/setup.sh --uninstall     # 一键清理:crontab 条目 + 循环进程 + .bashrc 守卫 + 配置文件
bash scripts/run_libsniper.sh         # 手跑一次验证(cron 模式的运行器)
# 循环模式专属:
pgrep -af loop_sniper                 # 查看常驻循环进程是否在跑
tail -f logs/loop.log                 # 看循环调度日志(下次触发时刻、退出码)
# crontab 模式专属:
crontab -l | grep libsniper           # 查看已注册的条目
tail -f logs/libsniper.log            # 看运行器日志
```

##### Ubuntu 日志位置

| 模式 | 日志文件 |
| --- | --- |
| crontab | `logs/libsniper.log`(主)+ `logs/libsniper_YYYYMMDD_HHMMSS.log`(归档,保留 30 天) |
| loop | `logs/loop.log`(循环调度器持续追加,含每次触发时刻与退出码) |

> 配置在 `<checkout>/.libsniper.env`(部署时冻结,已 gitignore)。改了 `SNIPER_DAILY_AT` 等环境变量后**重跑 `setup.sh`** 才会刷新该文件,已运行的循环进程需 `bash scripts/setup.sh --uninstall && bash scripts/setup.sh` 重启才会读到新时刻。

##### Ubuntu 故障排查

| 现象 | 排查 |
| --- | --- |
| `setup.sh` 报"未找到 miniconda" | `bash scripts/setup.sh` 会自动安装;若网络不通,手动 `wget https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh && bash Miniconda3-latest-Linux-x86_64.sh -b -p ~/miniconda3` |
| 服务器没有 cron / 没有 root | `setup.sh` 会自动检测并回退到**循环模式**(`loop_sniper.sh` 常驻),无需任何额外参数 |
| 循环进程没了(loop 模式) | 服务器重启后需**登录一次**触发 `~/.bashrc` 守卫自愈;或直接 `bash scripts/setup.sh` 重启循环 |
| 循环进程重复拉起 | 不会:`/tmp/libsniper_loop.lock` + `pgrep` 双重互斥;若确有多个,`pkill -f loop_sniper.sh` 后重跑 `setup.sh` |
| 注册后发现 crontab 里没条目 | `crontab -l` 查看;若服务器无 cron 服务,`setup.sh` 已自动改用循环模式(看 `pgrep -af loop_sniper`) |
| 每日没跑(crontab 模式) | ① 彻底关机后不会跑(见 [下方说明](#关于电脑关机与彻底断电)) ② `systemctl is-active cron` 检查 cron 服务 ③ `sudo tail -f /var/log/syslog \| grep CRON` 看执行记录 |
| 每日没跑(loop 模式) | `pgrep -af loop_sniper` 看进程在不在;`tail -f logs/loop.log` 看是否在等下次触发;进程没了就 `bash scripts/setup.sh` 重启 |
| 退出码 2(登录态失效) | 本地重跑 `python main.py` 用保存的学号+密码自动续登;若密码已改,在菜单选「重新登录」更新凭据 |

#### 关于电脑关机与彻底断电(跨平台共通)

**依赖物理开机 / 睡眠唤醒,彻底断电后任务不会跑。** 这是跨平台的共有约束,无论你用的是 `AutoSchedule.ps1`(Windows)还是 `setup.sh`(Ubuntu)。

| 你的情况 | 正确做法 |
| --- | --- |
| 每天用完睡眠 / 合盖(笔记本) | Windows 默认启用 `-WakeToRun`,BIOS 会自动唤醒;Ubuntu 需要 BIOS 支持 **Wake on RTC**,且在 `systemd` 中未禁用 wakeup(`cat /proc/driver/rtc`) |
| 每次都彻底关机断电(非睡眠) | **双方**都不会跑,改用 [GitHub Actions 备链路](docs/github-actions-setup.md) 或一台 24h 开机的设备 |
| 想关掉唤醒功能(省电) | Windows:注册前设 `$env:SNIPER_WAKE_TO_RUN = "false"`;Ubuntu:默认不写唤醒寄存器,无需操作 |

#### Windows 自定义配置(可选)

`scripts/AutoSchedule.ps1` 的所有常量均可通过**环境变量**覆盖。它们在脚本首次运行时被读取，**只需在注册任务前设置一次**（建议设为**系统或用户级**环境变量，永久生效）：

| 环境变量 | 作用 | 缺省值 |
| --- | --- | --- |
| `PYTHON_EXE` | 自定义 python.exe / pythonw.exe 路径 | 优先本地 `pythonw.exe`，退回 PATH |
| `SNIPER_WORKDIR` | 自定义工作目录 | **项目根目录** |
| `SNIPER_DAILY_AT` | 每日触发时间 | `19:59:59` |
| `SNIPER_TASK_NAME` | 计划任务名称 | `HDU-Library-Sniper-Daily` |
| `SNIPER_LOG_HISTORY` | 归档日志保留数（仅 `-Execute` 模式） | `30` |

> **设置示例**（PowerShell）：
>
> ```powershell
> # 设为用户级环境变量（永久生效）
> [System.Environment]::SetEnvironmentVariable('PYTHON_EXE', 'D:\Python313\python.exe', 'User')
>
> # 系统级（需要管理员，所有用户生效）
> [System.Environment]::SetEnvironmentVariable('SNIPER_DAILY_AT', '06:45AM', 'Machine')
> ```
>
> 设置后重新打开终端生效，再运行 `scripts/AutoSchedule.ps1` 注册任务。

#### Windows · 日志

- **默认模式**（`pythonw main.py --run-now`）：日志由 main.py 的 Notifier 写入 config.yaml 的 `paths.log_file`（`logs/booking.log`），并按 `notification.wechat_webhook` 推送
- **可选 `-Execute` 模式**（`powershell -File scripts\AutoSchedule.ps1 -Execute`）：额外把 stdout 重定向到 `<工作目录>/logs/task_log.txt`，单文件超 5MB 滚动为 `task_log_<时间戳>.txt`，保留最近 30 个，捕获 Python 非零退出码（⚠️ 标记）

#### Windows · 手动注册（备选）

如果想完全自定义任务计划参数，可手动参考以下配置（等价于 `scripts/AutoSchedule.ps1` 默认行为）：

1. 搜索打开"任务计划程序" → "创建基本任务"
2. 名称：`HDU 抢座`，触发器：每日 `19:59:59`
3. 操作 → 启动程序：
   - **程序**：`pythonw.exe` 的绝对路径（如 `C:\Python313\pythonw.exe`，**不要用 PATH 简称**——SYSTEM 账户的 PATH 可能找不到）
   - **参数**：`main.py --run-now`
   - **起始于（工作目录）**：本项目绝对路径（确保 `data/` `logs/` `config/` 相对路径可解析）
4. 属性 → "使用最高权限运行" / "不管用户是否登录都要运行"（避免锁屏拦截）

---

## ⚙️ 配置

通过 `config/config.yaml` 调整重试次数、超时时长、轮询间隔及微信通知 webhook 等参数。

### GitHub Actions（可选 · 备链路）

在 GitHub 上 fork 本仓库后，参考 [docs/github-actions-setup.md](docs/github-actions-setup.md) 设置 Secrets 即可触发每日自动抢座（仅限不在意跨境延迟的场景，主力仍推荐 [本地自动执行](#每日自动执行)）。

---

## 目录结构

```
.
├── main.py              # 终端交互入口 + 非交互模式入口
├── requirements.txt     # 依赖：requests, pyyaml
├── config/              # 配置目录（config.yaml + settings.py）
├── core/                # HTTP 客户端 / 抢座编排包 (Sniper/Plan/Retry/Repository)
├── utils/               # 加密 / 时间同步 / 验证码 / 通知 (Notifier)
├── data/                # 运行时数据（session.cache / plans.yaml，已 gitignore）
├── logs/                # 运行日志（已在 .gitignore）
├── scripts/
│   ├── AutoSchedule.ps1 # Windows 任务计划自动注册脚本（开箱即用）
│   ├── setup.sh         # Ubuntu 自动部署脚本(有 cron 用 cron,无 cron 回退常驻循环)
│   ├── run_libsniper.sh # crontab 模式的运行器(日志、锁、退出码解析)
│   └── loop_sniper.sh   # 循环模式运行器(无 cron/无 root 时的常驻调度器)
└── docs/github-actions-setup.md   # GitHub Actions 配置指南
```

> `data/session.cache` / `data/credentials.yaml` / `data/plans.yaml` 分别是登录态、学号+密码凭据和预约方案，已加入 `.gitignore`，不会被提交到 Git。
> `logs/` 是本地运行日志目录，同样已加入 `.gitignore`。

---

## ⚠️ 免责声明

- 本项目仅供学习交流使用，使用本工具产生的一切后果由使用者自行承担。
- 请勿滥用：频繁请求可能对正常服务造成影响，请合理设置重试间隔。
- 学号、密码与 Cookie 均为登录凭据，请勿在社交平台或不信任的环境中泄露。

---

*© 2026 LongElk (AlaIchhe) — MIT License*
