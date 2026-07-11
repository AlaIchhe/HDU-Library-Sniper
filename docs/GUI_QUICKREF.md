# HDU 图书馆抢座工具 - GUI 快速参考

## 🚀 启动

```bash
# 方法 1
python main.py --gui

# 方法 2
start_gui.bat        # Windows
bash start_gui.sh    # Linux/macOS
```

## 📋 三大功能标签

### 1️⃣ 认证
- 输入学号 + 密码
- 点击"登录"
- 等待后台 Playwright 完成 SSO 登录
- 凭据自动保存，下次启动自动认证

### 2️⃣ 方案管理
- 点击"刷新方案列表"查看所有方案
- ✓ = 已启用  ✗ = 未启用
- 创建方案暂时需要用 CLI: `python main.py`

### 3️⃣ 抢座
**立即执行**
- 执行时间框留空
- 点击"开始抢座"

**定时执行**
- 输入时间: `23:59:59` 或 `23:59`
- 点击"开始抢座"
- 观察倒计时

**取消任务**
- 点击"取消"按钮

## ⚙️ 配置文件

- `config/config.yaml` - 重试参数、通知配置
- `data/credentials.yaml` - 保存的学号密码（自动生成）
- `data/session.cache` - 登录态缓存（自动生成）
- `data/plans.yaml` - 预约方案配置

## 🔧 常见问题

**Q: 启动失败？**
```bash
pip install PySide6
playwright install chromium
```

**Q: 没有方案？**
```bash
python main.py  # 使用 CLI 创建方案
```

**Q: 登录失败？**
- 检查学号密码
- 检查网络连接
- 查看认证状态区域的详细错误

## 📊 运行模式对比

| 模式 | 命令 | 用途 |
|------|------|------|
| GUI | `python main.py --gui` | 日常使用，图形界面 |
| CLI | `python main.py` | 管理方案，交互操作 |
| 自动 | `python main.py --run-now` | 定时任务，无交互 |

## 🏗️ 技术架构

```
GUI (PySide6)
    ↓
QThread Workers (异步处理)
    ↓
Services (业务逻辑)
    ↓
Core (抢座引擎)
```

**线程安全**: 所有阻塞操作在独立线程执行，UI 永不卡顿

## 📝 日志符号

- `✓` - 成功
- `✗` - 失败
- `[OK]` - 正常状态
- `[FAIL]` - 错误状态

## 🎯 下一步

1. **首次使用**: 
   - 启动 GUI → 认证标签 → 输入学号密码 → 登录
   - 使用 CLI 创建方案: `python main.py`
   - 返回 GUI → 方案管理 → 刷新查看
   - 抢座标签 → 设置时间 → 开始

2. **日常使用**:
   - 启动 GUI（自动认证）
   - 方案管理 → 刷新（确认方案）
   - 抢座 → 输入时间 → 开始

3. **定时任务**:
   - Windows: `scripts/AutoSchedule.ps1`
   - Linux: `bash scripts/setup.sh`

## 📚 完整文档

- 使用说明: `docs/GUI_USAGE.md`
- 架构设计: `docs/GUI_ARCHITECTURE.md`
- 项目 README: `README.md`
