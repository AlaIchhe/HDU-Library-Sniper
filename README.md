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
| 🛡️ 超时幂等确认 | `bookSeats` 响应超时时自动查询今日预约列表做服务端确认，避免误报失败 |
| 🍪 Cookie 缓存 | 登录一次后复用，支持浏览器 JSON Cookie / 原始 Cookie 字符串 |
| 📦 多方案容错 | 支持配置多个房间/座位方案，主方案失败自动切备选 |
| 📨 通知推送 | 控制台 + 本地日志文件 + 微信 webhook（Server酱 / PushPlus 等） |

---

## 📁 项目结构

```
HDU-Library-Sniper/
├── main.py              # 终端交互界面入口（--run-now 供定时任务调用）
├── config/
│   ├── config.yaml      # 运行时配置（重试次数、超时、webhook 等）
│   └── setting.py       # YAML → dataclass 配置加载器
├── core/
│   ├── client.py        # HTTP 客户端（登录验证、房间/座位查询、预约提交）
│   └── sniper.py        # 预约编排器 + 重试决策逻辑 + YAML 方案持久化
├── data/
│   ├── plans.yaml*      # 预约方案（本地生成，含学号 → 已加入 .gitignore）
│   └── session.cache*   # Cookie 缓存（本地生成，已加入 .gitignore）
├── logs/
│   └── booking.log*     # 预约结果日志（本地生成）
└── utils/
    ├── encrypt.py       # API Token 签名（MD5 → base64）
    ├── time_sync.py     # 北京时间工具、预约时间戳构造
    └── captcha.py       # （预留）验证码支持
```

> `*` 标记文件本地运行后自动生成，已加入 `.gitignore`，不会提交到仓库。

---

## 🚀 快速开始

### 环境要求

- Python 3.10+
- 依赖库见下表（使用 `pip install -r requirements.txt` 安装）

```
requests>=2.31
pyyaml>=6.0
```

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

进入菜单选择「登录验证」→ 粘贴浏览器中 `hdu.huitu.zhishulib.com` 的 Cookie（F12 → Network → 任意请求的 Request Headers 中获取）。

Cookie 验证成功后会被缓存到 `data/session.cache`，后续无需重复粘贴。

### 添加预约方案

菜单选择「添加方案」，按提示输入：
- 房间类型（1=自习室 / 2=教师休息室 / 3=阅览室 / 4=讨论室）
- 楼层 ID、座位号
- 开始时间（小时，如 `9` 表示 09:00）
- 自习时长（小时）
- 预约哪天的（0=今天，1=明天 …）

### 启动抢座

```bash
# 抢今天/明天的座位
python main.py → 选择「开始抢座」

# 定时到指定时间开抢（可用于整点放号的场景）
python main.py → 选择「定时预约」→ 输入目标时间 07:00:00

# 供 Windows 任务计划程序调用的非交互模式
python main.py --run-now
```

`--run-now` 退出码含义：
| 退出码 | 含义 |
| --- | --- |
| 0 | 至少一个方案成功 |
| 1 | 全部方案失败 |
| 2 | Cookie 认证过期 |
| 3 | 没有启用的方案 |

---

## ⚙️ 关键配置

编辑 `config/config.yaml`：

```yaml
booking:
  max_trials: 5          # 每个方案最大重试次数
  retry_delay: 1.0       # 基础重试延迟（秒），实际按指数退避 + 抖动
  dry_run: false         # 预览模式：构造请求不提交
  window_wait_seconds: 30.0   # "窗口未开放"最长等待秒数
  window_poll_interval: 1.0   # 等待窗口开放的轮询间隔

paths:
  session_cache: data/session.cache
  plans_file: data/plans.yaml
  log_file: logs/booking.log

notification:
  wechat_webhook: ""     # 微信通知 webhook（Server酱 等），留空则不推送
```

---

## 🔧 超时幂等确认（核心修复）

> 解决整点抢座时 `Read timed out` 导致预约成功却被误报失败的问题。

**问题场景**：`POST /Seat/Index/bookSeats` 请求已发送到服务器，服务器成功写入预约，但响应在 10s 内未返回（常见于整个校园网同时开抢的高并发时刻）。客户端按"请求失败"处理并重试，随即收到服务器"已有预约，请勿重复预约"的错误，最终输出"预约失败"——但座位实际上已订好。

**修复方案**（`core/sniper.py`）：

```
bookSeats 请求──→ HduLibraryError(is_timeout=True)
                         │
                         ▼
              调用 GET /Seat/Index/todayUserBookSeat
                         │
               ┌────┬────┴────┬────┐
               │    │         │    │
          查询异常 无预约   找到匹配预约
               │    │         │
               ▼    ▼         ▼
            返回    返回    返回
            False   False    True
            (按原   (按原   → booking
            逻辑    逻辑    success=True
            重试)   重试)   "已服务端确认")
```

详见 `client.py` 的 `HduLibraryError` 类（`is_timeout` 属性）和 `_idempotent_confirm()` 方法。

---

## ⚠️ 免责声明

- 本项目仅供学习交流使用，使用本工具产生的一切后果由使用者自行承担。
- 请勿滥用：频繁请求可能对正常服务造成影响，请合理设置重试间隔。
- Cookie 是登录凭据，请勿在社交平台或不信任的环境中泄露。

---

*© 2026 LongElk (AlaIchhe) — MIT License*
