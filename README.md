# HDU-Library-Sniper

> 杭州电子科技大学图书馆座位自动抢座工具。

支持**即时抢座**与**定时预约**两种模式，具备指数退避重试、Cookie 缓存、多方案容错、超时幂等确认等特性。

---

## ✨ 功能特性

| 特性 | 说明 |
| --- | --- |
| ⚡ 即时抢座 | 立即尝试预约，按方案优先级逐个尝试，任一成功即停止 |
| 🕗 定时预约 | 设定目标时间（如 `07:00:00`），程序自动等待到点后发起抢占 |
| 🔁 智能重试 | 指数退避 + 随机抖动，对"预约窗口未开放"独立轮询（不占用重试预算） |
| 🛡️ 超时幂等确认 | 抢座请求响应超时时自动查询今日预约列表做服务端确认，避免成功却误报失败 |
| 🍪 Cookie 缓存 | 登录一次后复用，支持浏览器 JSON Cookie / 原始 Cookie 字符串 |
| 📦 多方案容错 | 支持配置多个房间/座位方案，主方案失败自动切备选 |
| 📨 通知推送 | 控制台 + 本地日志文件 + 微信 webhook（Server酱 / PushPlus 等） |

---

## 🚀 快速开始

### 环境要求

- Python 3.10+
- 依赖：`requests>=2.31`、`pyyaml>=6.0`（使用 `pip install -r requirements.txt` 安装）

### 安装

```bash
git clone https://github.com/AlaIchhe/HDU-Library-Sniper.git
cd HDU-Library-Sniper
pip install -r requirements.txt
```

### 登录验证

首次运行需要加载 Cookie：

```bash
python main.py
```

选择「登录验证」→ 粘贴浏览器中 `hdu.huitu.zhishulib.com` 的 Cookie（F12 → Network → 任意请求的 Request Headers 中获取）。Cookie 验证成功后会被缓存，后续无需重复粘贴。

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
| 2 | Cookie 认证过期 |
| 3 | 没有启用的方案 |

### 每日自动执行

项目不提供内置定时器，而是通过 [--run-now](#--run-now-退出码) 与操作系统调度器对接，单日单进程跑完即退出。

#### ✅ 推荐：自动注册（Windows 任务计划程序）—— 开箱即用

仓库根目录提供 `AutoSchedule.ps1`，**以管理员身份运行 PowerShell 一次即可自动注册**，无需手动拼装路径：

```powershell
# 1. 打开文件所在文件夹
# 2. 右键 AutoSchedule.ps1 → "使用 PowerShell 运行"（或在管理员 PowerShell 中 cd 到此目录后执行 ./AutoSchedule.ps1）
```

脚本会自动：

- 把**脚本所在目录**作为工作目录（不再硬编码路径），并锁定为任务 Action 的 `WorkingDirectory`，确保 `data/` `logs/` `config/` 相对路径在 SYSTEM 账户下可解析
- **优先锁定本地** `pythonw.exe`：先在脚本目录 / 本地 venv 查找，再退回 `PYTHON_EXE` 环境变量与 PATH，最终用绝对路径写入 Action（SYSTEM 账户的 PATH 不可靠）
- 注册一个每日 `19:59:59` 触发的计划任务（NT AUTHORITY\SYSTEM，**不管用户是否登录都运行**，电池供电也可运行）
- 操作为 `pythonw main.py --run-now`（无窗口），日志由 main.py 的 Notifier 写入 config.yaml 的 `paths.log_file`
- 输出任务名、工作目录、实际 Python 路径，便于二次确认
- 找不到 pythonw.exe 会**立即报错（退出码 7）**，避免静默失败后过几天才发现没抢到

注册成功后可在"任务计划程序库"找到 `HDU-Library-Sniper-Daily`，右键 → "运行"手动验证一次。

#### 关于电脑关机

任务计划依赖 CPU 供电，**彻底断电关机后任务不会跑**。脚本默认启用 `-WakeToRun`：**睡眠状态下的笔记本可自动被 BIOS 唤醒**，合盖 / 关显示 / 睡眠都能触发。

如果你想：

| 你的情况 | 正确做法 |
| --- | --- |
| 每天用完睡眠 / 合盖 | 默认设置已经能触发，无需改动 |
| 每次都彻底关机断电（非睡眠） | 任务**不会**跑，改用 [GitHub Actions 备链路](docs/github-actions-setup.md) 或一台 24h 开机的设备 |
| 想关掉唤醒功能（省电） | 注册前设 `$env:SNIPER_WAKE_TO_RUN = "false"` 再跑脚本 |

#### 自定义配置（可选）

`AutoSchedule.ps1` 的所有常量均可通过**环境变量**覆盖。它们在脚本首次运行时被读取，**只需在注册任务前设置一次**（建议设为**系统或用户级**环境变量，永久生效）：

| 环境变量 | 作用 | 缺省值 |
| --- | --- | --- |
| `PYTHON_EXE` | 自定义 python.exe / pythonw.exe 路径 | 优先本地 `pythonw.exe`，退回 PATH |
| `SNIPER_WORKDIR` | 自定义工作目录 | **脚本所在目录** |
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
> 设置后重新打开终端生效，再运行 `AutoSchedule.ps1` 注册任务。

#### 日志

- **默认模式**（`pythonw main.py --run-now`）：日志由 main.py 的 Notifier 写入 config.yaml 的 `paths.log_file`（`logs/booking.log`），并按 `notification.wechat_webhook` 推送
- **可选 `-Execute` 模式**（`powershell -File AutoSchedule.ps1 -Execute`）：额外把 stdout 重定向到 `<工作目录>/logs/task_log.txt`，单文件超 5MB 滚动为 `task_log_<时间戳>.txt`，保留最近 30 个，捕获 Python 非零退出码（⚠️ 标记）

#### 手动注册（备选）

如果想完全自定义任务计划参数，可手动参考以下配置（等价于 `AutoSchedule.ps1` 默认行为）：

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
├── AutoSchedule.ps1     # Windows 任务计划自动注册脚本（开箱即用）
├── requirements.txt     # 依赖：requests, pyyaml
├── config/              # 配置目录（config.yaml + setting.py）
├── core/                # HTTP 客户端 / Notifier / PlanRepository / Sniper
├── utils/               # 加密 / 时间同步 / 验证码
├── data/                # 运行时数据（session.cache / plans.yaml，已 gitignore）
├── logs/                # 运行日志
└── docs/github-actions-setup.md   # GitHub Actions 配置指南
```

> `data/session.cache` / `data/plans.yaml` 是登录凭据和预约方案，已加入 `.gitignore`，不会被提交到 Git。

---

## ⚠️ 免责声明

- 本项目仅供学习交流使用，使用本工具产生的一切后果由使用者自行承担。
- 请勿滥用：频繁请求可能对正常服务造成影响，请合理设置重试间隔。
- Cookie 是登录凭据，请勿在社交平台或不信任的环境中泄露。

---

*© 2026 LongElk (AlaIchhe) — MIT License*
