# HDU-Library-Sniper

> 杭州电子科技大学图书馆座位自动抢座工具。

支持**即时抢座**与**定时预约**两种模式，具备指数退避重试、登录态缓存、多方案容错、超时幂等确认等特性。

---

## ✨ 功能特性

| 特性 | 说明 |
| --- | --- |
| 🎨 图形界面 | 简洁易用的 GUI 界面，方案配置、抢座、定时任务一站式管理 |
| ⚡ 即时抢座 | 立即尝试预约，按方案优先级逐个尝试，任一成功即停止 |
| 🕗 定时预约 | 设定目标时间（如 `23:59:55`），程序自动等待到点后发起抢占 |
| ⏰ 定时任务 | 一键配置系统定时任务，每天自动抢座，无需手动执行 |
| 🔁 智能重试 | 指数退避 + 随机抖动，对"预约窗口未开放"独立轮询（不占用重试预算） |
| 🛡️ 超时幂等确认 | 抢座请求响应超时时自动查询今日预约列表做服务端确认，避免成功却误报失败 |
| 🔐 账号密码登录 | 学号 + 数字杭电密码 headless 自动登录，无需扫码 / 手动复制 Cookie |
| 🍪 登录态缓存 | 登录一次后复用 cookie，过期自动用学号+密码 headless 续登 |
| 📦 多方案容错 | 支持配置多个房间/座位方案，主方案失败自动切备选 |
| 📨 通知推送 | 本地日志文件 + 微信 webhook（Server酱 / PushPlus 等） |

---

## 🚀 快速开始

### 环境要求

- Python 3.10+
- 依赖：`requests`、`pyyaml`、`playwright`、`PySide6`（使用 `pip install -r requirements.txt` 安装）
- 浏览器二进制：`playwright install chromium`（headless 登录用，约 150MB，仅首次）

### 安装

```bash
git clone https://github.com/AlaIchhe/HDU-Library-Sniper.git
cd HDU-Library-Sniper
pip install -r requirements.txt
playwright install chromium
```

### 启动软件

**Windows 用户（推荐）**：
- 双击 `HDU图书馆抢座.vbs` — 静默启动，无命令行窗口

**其他方式**：
```bash
python main.py          # 启动 GUI 界面
start.bat               # Windows 批处理启动
bash start.sh           # Linux/macOS Shell 启动
```

---

## 📖 使用指南

### 1. 登录认证

启动软件后，在"认证"标签页输入：
- **学号**：你的学号
- **密码**：数字杭电密码

点击"登录"按钮，程序会在后台启动 headless 浏览器完成登录，自动保存登录态到 `data/session.cache`。

凭据会保存到 `data/credentials.yaml`（已 gitignore），供后续自动续登使用。

> 登录依赖 Playwright（headless 浏览器）：
> ```bash
> pip install -r requirements.txt   # 含 playwright
> playwright install chromium       # 下载浏览器二进制（约 150MB，仅首次）
> ```
>
> 无桌面环境（SSH / Linux 服务器 / SYSTEM 计划任务）也能 headless 登录，只要已安装 chromium。

### 2. 创建预约方案

切换到"方案管理"标签页，点击"创建方案"：

1. **选择房间类型**：自习室、阅览室、讨论室等
2. **选择楼层**：程序会自动加载该房间类型的所有楼层
3. **输入座位号**：根据提示输入目标座位号（显示可用座位参考）
4. **设置时间**：
   - 开始小时：如 `13` 表示 13:00
   - 使用时长：如 `9` 表示 9 小时
   - 天数偏移：`0` = 今天，`1` = 明天（图书馆通常提前 1 天预约）

点击"确定"创建方案。

**其他功能**：
- **删除方案**：多选删除不需要的方案
- **批量修改时间**：一次性修改多个方案的时间参数
- **浏览房间**：查看所有可用楼层和座位信息

### 3. 手动抢座（可选）

切换到"抢座"标签页：

- **立即执行**：留空执行时间，点击"开始抢座"
- **定时执行**：输入时间（如 `23:59:55`），程序会倒计时等待到点后执行

适合临时测试方案或手动抢座。

### 4. 配置定时任务（推荐）

切换到"定时任务"标签页，点击"配置定时任务"：

1. **设置执行时间**：例如 `23:59:55`（图书馆 0:00 开放预约，提前 5 秒准备）
2. **Windows 用户**：勾选"唤醒计算机以运行任务"（睡眠状态也能自动唤醒执行）
3. 点击"确定"

配置完成后：
- ✅ 每天该时间会自动执行抢座
- ✅ 可以关闭软件，系统会自动触发
- ✅ Windows：需保持电脑开机或睡眠（支持自动唤醒）
- ✅ Linux：需保持电脑开机
- ✅ 执行结果会推送通知（如已配置通知渠道）
- ✅ 详细日志保存在 `logs/` 目录

**其他功能**：
- **移除定时任务**：取消自动执行
- **测试执行**：立即执行一次后台任务，验证配置是否正确
- **刷新状态**：查看当前定时任务配置状态

---

## ⚙️ 定时任务技术细节

### Windows 实现

GUI 调用 `scripts/AutoSchedule.ps1` 自动注册到 Windows 任务计划程序：
- 任务名称：`HDU-Library-Sniper-Daily`
- 账户：`NT AUTHORITY\SYSTEM`（不管用户是否登录都运行）
- 触发器：每天指定时间
- 操作：`pythonw.exe main.py --daemon`
- 支持睡眠唤醒（可配置）

可在"任务计划程序"中查看和管理：
```
Win + R → taskschd.msc → 任务计划程序库 → HDU-Library-Sniper-Daily
```

### Linux 实现

GUI 自动配置 crontab：
- 每天指定时间触发
- 命令：`python3 main.py --daemon`
- 日志输出到 `logs/task.log`

查看已配置任务：
```bash
crontab -l | grep main.py
```

### 后台执行模式

定时任务触发的命令：
```bash
python main.py --daemon    # 或 pythonw.exe (Windows)
```

**执行流程**：
1. 读取配置文件（`plans.yaml`, `credentials.yaml`）
2. 尝试使用缓存登录，失败则用凭据续登
3. 读取启用的方案
4. 执行抢座（带重试、窗口轮询）
5. 推送通知
6. 记录日志
7. 退出，返回退出码

**退出码**：
| 退出码 | 含义 |
| --- | --- |
| 0 | 至少一个方案成功 |
| 1 | 全部方案失败 |
| 2 | 登录态过期且凭据续登失败 |
| 3 | 没有启用的方案 |

**特点**：
- ✅ 完全非交互（无任何输入输出）
- ✅ 适合系统定时任务调用
- ✅ 轻量级（不加载 GUI 依赖）
- ✅ 日志文件记录详细信息

---

## 📁 目录结构

```
.
├── main.py              # 统一入口（GUI 模式 / 后台守护进程模式）
├── requirements.txt     # 依赖：requests, pyyaml, playwright, PySide6
├── start.bat            # Windows 启动脚本
├── start.sh             # Linux/macOS 启动脚本
├── HDU图书馆抢座.vbs    # Windows 静默启动（无命令行窗口）
├── config/              # 配置目录（config.yaml + settings.py）
├── gui/                 # GUI 界面
│   ├── main_window.py   # 主窗口（认证、方案管理、抢座、定时任务）
│   ├── dialogs/         # 对话框（创建方案、删除方案、修改时间、浏览房间、定时任务配置）
│   ├── workers.py       # 异步工作线程（BookingWorker、AuthWorker、LoadFloorsWorker）
│   └── app.py           # GUI 启动入口
├── services/            # 业务逻辑层
│   ├── auth.py          # 认证服务
│   ├── booking.py       # 抢座服务
│   ├── plans.py         # 方案管理服务
│   ├── scheduler.py     # 定时任务管理服务
│   └── runtime.py       # 运行时构建
├── core/                # HTTP 客户端 / 抢座编排包 (Sniper/Plan/Retry/Repository)
├── utils/               # 加密 / 时间同步 / 验证码 / 通知 (Notifier)
├── data/                # 运行时数据（session.cache / plans.yaml / credentials.yaml，已 gitignore）
├── logs/                # 运行日志（已在 .gitignore）
├── scripts/
│   └── AutoSchedule.ps1 # Windows 任务计划自动注册脚本
└── docs/
    ├── github-actions-setup.md # GitHub Actions 配置指南（备选方案）
    └── archive/         # 历史实施报告归档
```

> `data/session.cache` / `data/credentials.yaml` / `data/plans.yaml` 分别是登录态、学号+密码凭据和预约方案，已加入 `.gitignore`，不会被提交到 Git。
> `logs/` 是本地运行日志目录，同样已加入 `.gitignore`。

---

## ❓ 常见问题

### Q: 配置定时任务后需要一直开着软件吗？

A: 不需要。配置完成后可以关闭软件，系统会在指定时间自动触发后台执行。

### Q: 电脑关机了还能抢座吗？

A: 不能。需要保持电脑开机或睡眠状态。
- **Windows**：睡眠状态下可自动唤醒执行（默认启用）
- **Linux**：需要 BIOS 支持 Wake on RTC
- **完全关机**：任务不会执行，建议使用 [GitHub Actions 备选方案](docs/github-actions-setup.md)

### Q: 如何查看抢座结果？

A: 三种方式：
1. 查看通知推送（需在 `config/config.yaml` 配置 webhook）
2. 查看 `logs/` 目录下的日志文件
3. 在 GUI 的"定时任务"标签页点击"测试执行"查看执行情况

### Q: 如何修改定时任务的执行时间？

A: 重新点击"配置定时任务"，输入新的时间即可覆盖原有配置。

### Q: 定时任务执行失败怎么办？

A: 
1. 点击"测试执行"按钮，查看具体错误信息
2. 检查日志文件 `logs/` 目录
3. 确认方案已启用（在"方案管理"标签页查看）
4. 确认登录状态有效（在"认证"标签页重新登录）

### Q: 支持哪些操作系统？

A: 
- ✅ Windows 10/11
- ✅ Linux（Ubuntu、Debian、CentOS 等）
- ✅ macOS

---

## 🔧 高级配置

### 通知推送

编辑 `config/config.yaml`：

```yaml
notification:
  wechat_webhook: "https://sctapi.ftqq.com/your_token.send"  # Server酱
  # 或
  wechat_webhook: "http://www.pushplus.plus/send?token=your_token"  # PushPlus
```

### 重试策略

编辑 `config/config.yaml`：

```yaml
max_trials: 5                    # 最大重试次数
retry_delay: 1.5                 # 重试间隔（秒）
window_wait_seconds: 300         # 窗口未开放时等待时间（秒）
window_poll_interval: 2          # 窗口轮询间隔（秒）
```

### GitHub Actions（备选方案）

在 GitHub 上 fork 本仓库后，参考 [docs/github-actions-setup.md](docs/github-actions-setup.md) 设置 Secrets 即可触发每日自动抢座（适合无法保持电脑开机的场景）。

---

## ⚠️ 免责声明

- 本项目仅供学习交流使用，使用本工具产生的一切后果由使用者自行承担。
- 请勿滥用：频繁请求可能对正常服务造成影响，请合理设置重试间隔。
- 学号、密码与 Cookie 均为登录凭据，请勿在社交平台或不信任的环境中泄露。

---

*© 2026 LongElk (AlaIchhe) — MIT License*
