# HDU-Library-Sniper

> 杭州电子科技大学图书馆座位自动抢座工具。

支持**即时抢座**与**定时预约**两种模式，具备指数退避重试、登录态缓存、多方案容错、超时幂等确认等特性。

---

## ✨ 功能特性

| 特性 | 说明 |
| --- | --- |
| 🎨 跨平台界面 | Flet/Flutter 桌面端与 Docker Web UI 共用同一套交互体验 |
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

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) - 现代 Python 包管理器
- 浏览器二进制：`playwright install chromium`（headless 登录用，约 150MB，仅首次）

### 安装

**1. 安装 uv（如果未安装）**

Windows (PowerShell):
```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

macOS/Linux:
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**2. 克隆项目并安装依赖**

```bash
git clone https://github.com/AlaIchhe/HDU-Library-Sniper.git
cd HDU-Library-Sniper

# 安装依赖（自动创建虚拟环境）
uv sync

# 安装浏览器
uv run playwright install chromium
```

### 启动软件

**Windows 用户（推荐）**：
- 双击 `scripts/launch.bat` — 静默启动，无命令行窗口

**命令行启动**：
```bash
uv run python main.py   # 使用 uv 运行
# 或
make run                # 使用 Makefile

# 本地启动 Web UI（服务器/Docker 使用同一入口）
uv run python main.py --web
```

Docker 部署参见 [docs/DOCKER.md](docs/DOCKER.md)。默认 Web 地址为 `http://localhost:8000`。
分层和多宿主边界参见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 📖 使用指南

### 1. 登录认证

启动软件后，在"认证"标签页输入：
- **学号**：你的学号
- **密码**：数字杭电密码

点击"登录"按钮，程序会在后台启动 headless 浏览器完成登录，并将登录态保存到当前用户的标准应用数据目录。

凭据保存在当前用户的标准应用数据目录，供后续自动续登使用；不会写入源码仓库。

> 登录依赖 Playwright（headless 浏览器）：
> ```bash
> uv sync
> uv run playwright install chromium  # 下载浏览器二进制（约 150MB，仅首次）
> ```
>
> 无桌面环境（SSH / Linux 服务器 / 系统计划任务）也能 headless 登录，只要已安装 chromium。

### 2. 创建预约方案

切换到"方案"工作区，填写新建方案表单：

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

切换到"执行"工作区：

- **立即执行**：留空执行时间，点击"开始抢座"
- **定时执行**：输入时间（如 `23:59:55`），程序会倒计时等待到点后执行

适合临时测试方案或手动抢座。

### 4. 配置定时任务（推荐）

切换到"调度"工作区，填写每天执行时间并保存：

1. **设置执行时间**：例如 `23:59:55`（图书馆 0:00 开放预约，提前 5 秒准备）
2. **Windows 用户**：勾选"唤醒计算机以运行任务"（睡眠状态也能自动唤醒执行）
3. 点击"确定"

配置完成后：
- ✅ 每天该时间会自动执行抢座
- ✅ 可以关闭软件，系统会自动触发
- ✅ Windows：需保持电脑开机或睡眠（支持自动唤醒）
- ✅ Linux：需保持电脑开机
- ✅ 执行结果会推送通知（如已配置通知渠道）
- ✅ 详细日志保存在当前用户的标准日志目录

**其他功能**：
- **移除定时任务**：取消自动执行
- **测试执行**：立即执行一次后台任务，验证配置是否正确
- **刷新状态**：查看当前定时任务配置状态

---

## ⚙️ 定时任务技术细节

### Windows 实现

应用调用 `scripts/AutoSchedule.ps1` 自动注册到 Windows 任务计划程序：
- 任务名称：`HDU-Library-Sniper-Daily`
- 账户：创建任务的当前桌面用户
- 触发器：每天指定时间
- 操作：PowerShell 包装器调用当前 Python 与 `main.py --run-now`
- 支持睡眠唤醒（可配置）

可在"任务计划程序"中查看和管理：
```
Win + R → taskschd.msc → 任务计划程序库 → HDU-Library-Sniper-Daily
```

### Linux 实现

应用自动配置 crontab：
- 每天指定时间触发
- 命令：当前 Python 解释器与 `main.py --daemon` 的绝对路径
- 日志输出到标准用户日志目录中的 `task.log`

查看已配置任务：
```bash
crontab -l | grep HDU-Library-Sniper
```

### 后台执行模式

定时任务触发的命令：
```bash
python main.py --daemon    # 或 pythonw.exe (Windows)
```

**执行流程**：
1. 从系统标准用户目录读取设置、方案和凭据
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
- ✅ 轻量级（不加载 UI 模块）
- ✅ 日志文件记录详细信息

---

## 📁 目录结构

```
HDU-Library-Sniper/
├── main.py                      # 统一入口（Flet 桌面/Web / 后台执行）
├── pyproject.toml               # 项目配置（依赖、工具链）
├── uv.lock                      # 依赖锁定文件
├── Makefile                     # 快捷命令（install/lint/test/run/docker-*）
├── Dockerfile                   # Docker 多阶段构建配置
├── docker-compose.yml           # Docker 多模式编排（web/run/scheduled）
├── docker-entrypoint.sh         # Docker 智能入口脚本
├── .env.example                 # Docker 环境变量模板
│
├── src/                         # 核心业务代码
│   ├── config/                  # 配置与运行目录解析
│   │   ├── paths.py             # 标准用户目录 / HDU_SNIPER_HOME
│   │   └── settings.py          # 业务配置与凭据加载
│   │
│   ├── core/                    # 核心业务逻辑
│   │   ├── client.py            # 图书馆 API 客户端
│   │   ├── contract.py          # 接口契约定义
│   │   ├── room_browser.py      # 房间/座位查询
│   │   └── sniper/              # 抢座引擎
│   │       ├── sniper.py        # 核心抢座逻辑
│   │       ├── plan.py          # 预约方案模型
│   │       ├── retry.py         # 重试策略
│   │       └── repository.py    # 方案持久化
│   │
│   ├── application/             # 与 UI 框架无关的应用门面和事件模型
│   ├── interfaces/              # FastAPI/ASGI 服务入口
│   ├── ui/                      # Flet 桌面/Web 共用界面
│   │   └── flet_app.py          # 桌面/Web 共用控件树
│   │
│   ├── services/                # 业务逻辑层
│   │   ├── auth.py              # 认证服务
│   │   ├── booking.py           # 抢座服务
│   │   ├── plans.py             # 方案管理服务
│   │   ├── scheduler.py         # 定时任务管理服务
│   │   ├── runtime.py           # 运行时构建
│   │   └── browser_auth.py      # 浏览器自动登录
│   │
│   └── utils/                   # 工具函数
│       ├── encrypt.py           # API 签名生成
│       ├── notifier.py          # 通知推送（日志 + 微信 webhook）
│       ├── time_sync.py         # 时间同步
│       └── time_utils.py        # 时间解析工具
│
├── scripts/
│   ├── AutoSchedule.ps1         # Windows 任务计划自动注册脚本
│   ├── launch.bat               # Windows 静默启动脚本
│   └── launch.ps1               # Windows PowerShell 启动脚本
│
├── tests/                       # 测试套件
│   ├── test_contracts.py        # 接口契约测试
│   └── test_scheduler.py        # 定时任务测试
│
└── docs/                        # 文档
    ├── DOCKER.md                # Docker 部署完整指南
    └── contracts/               # API 契约示例
```

> ⚠️ **安全提示**：桌面端运行数据位于操作系统标准用户目录；Docker/服务器位于 `HDU_SNIPER_HOME`。凭据和会话缓存都不应提交到仓库。

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
1. 查看通知推送（在用户配置目录的 `settings.yaml` 中配置 webhook）
2. 查看用户日志目录中的日志文件
3. 在"调度"工作区点击"测试执行"查看执行情况

### Q: 如何修改定时任务的执行时间？

A: 重新点击"配置定时任务"，输入新的时间即可覆盖原有配置。

### Q: 定时任务执行失败怎么办？

A: 
1. 点击"测试执行"按钮，查看具体错误信息
2. 检查标准用户日志目录
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

参考 `config.example.yaml`，编辑用户配置目录中的 `settings.yaml`：

```yaml
notification:
  wechat_webhook: "https://sctapi.ftqq.com/your_token.send"  # Server酱
  # 或
  wechat_webhook: "http://www.pushplus.plus/send?token=your_token"  # PushPlus
```

### 重试策略

编辑同一个 `settings.yaml`：

```yaml
schema_version: 1
booking:
  max_trials: 5
  retry_delay: 1.5
  window_wait_seconds: 300
  window_poll_interval: 2
```

### GitHub Actions（备选方案）

在 GitHub 上 fork 本仓库后，参考 [docs/github-actions-setup.md](docs/github-actions-setup.md) 设置 Secrets 即可触发每日自动抢座（适合无法保持电脑开机的场景）。

---

## 🛠️ 开发指南

### 开发环境设置

```bash
# 安装所有开发依赖
uv sync --all-groups

# 或使用 Makefile
make dev
```

### 常用命令

```bash
# 代码检查
make lint              # 运行 ruff 检查
uv run ruff check .

# 代码格式化
make format            # 自动格式化
uv run ruff format .

# 运行测试
make test              # 运行测试套件
uv run pytest

# 运行应用
make run               # 启动 Flet 桌面端
uv run python main.py

make web               # 启动本地 Web UI
uv run python main.py --web

# 清理缓存
make clean
```

### 项目结构

```
HDU-Library-Sniper/
├── main.py              # 统一入口
├── pyproject.toml       # 项目配置
├── uv.lock              # 依赖锁定
├── Makefile             # 快捷命令
├── Dockerfile           # Docker 构建
├── docker-compose.yml   # Docker 编排
├── config.example.yaml # 业务配置示例
│
├── src/                 # 核心业务代码
│   ├── config/          # 配置管理
│   ├── core/            # 核心业务逻辑
│   │   └── sniper/      # 抢座引擎
│   ├── application/     # 应用门面与事件模型
│   ├── interfaces/      # FastAPI/ASGI 入口
│   ├── ui/              # Flet 桌面/Web 共用界面
│   ├── services/        # 业务逻辑层
│   └── utils/           # 工具函数
│
├── scripts/             # 脚本
├── deploy/config/       # Docker/服务器配置挂载点
├── tests/               # 测试套件
└── docs/                # 文档
```

### 技术栈

- **包管理**: [uv](https://docs.astral.sh/uv/) - 快速、现代的 Python 包管理器
- **代码质量**: [ruff](https://docs.astral.sh/ruff/) - 极速 linter + formatter
- **测试**: [pytest](https://pytest.org/) + pytest-cov
- **跨平台 UI**: [Flet](https://flet.dev/) / Flutter（Windows、macOS、Web 共用控件树）
- **Web/API**: [FastAPI](https://fastapi.tiangolo.com/) + ASGI
- **自动化**: [Playwright](https://playwright.dev/python/) - 浏览器自动化

### 贡献指南

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

**代码规范**:
- 运行 `make lint` 确保代码通过检查
- 运行 `make format` 自动格式化代码
- 运行 `make test` 确保测试通过

---

## ⚠️ 免责声明

- 本项目仅供学习交流使用，使用本工具产生的一切后果由使用者自行承担。
- 请勿滥用：频繁请求可能对正常服务造成影响，请合理设置重试间隔。
- 学号、密码与 Cookie 均为登录凭据，请勿在社交平台或不信任的环境中泄露。

---

*© 2026 LongElk (AlaIchhe) — MIT License*
