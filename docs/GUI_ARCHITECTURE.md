# GUI 架构设计

## 目录结构

```
gui/
├── __init__.py           # 模块初始化
├── app.py               # GUI 应用入口
├── main_window.py       # 主窗口（核心UI逻辑）
├── workers.py           # QThread 工作线程
└── widgets/             # 自定义组件（待扩展）
    └── __init__.py
```

## 架构分层

### 1. 表现层 (Presentation Layer)
- **main_window.py**: 主窗口类，负责 UI 布局和用户交互
  - 三个标签页：认证、方案管理、抢座
  - 信号/槽连接
  - UI 状态管理

### 2. 业务逻辑层 (Business Logic Layer)
- **复用现有 services 层**:
  - `AuthService`: 认证服务
  - `BrowserAuthService`: 浏览器登录服务
  - `BookingService`: 抢座服务
  - `PlanService`: 方案管理服务

### 3. 并发处理层 (Concurrency Layer)
- **workers.py**: QThread 工作线程
  - `BookingWorker`: 抢座任务线程
  - `AuthWorker`: 认证任务线程
  - 通过信号向主线程发送进度和结果

## 设计模式

### 1. MVC 模式变体
```
View (UI)          Controller (MainWindow)      Model (Services)
┌─────────┐        ┌──────────────────┐        ┌──────────────┐
│ QWidget │◄──────►│   MainWindow     │◄──────►│ BookingService│
│ QLabel  │        │   - handle_*     │        │ PlanService   │
│ QButton │        │   - on_*         │        │ AuthService   │
└─────────┘        └──────────────────┘        └──────────────┘
```

### 2. 信号/槽模式
```python
# 工作线程发送信号
self.countdown_updated.emit(remaining)
self.progress_updated.emit(result)
self.finished.emit(results)

# 主窗口接收信号
worker.countdown_updated.connect(self._on_countdown_update)
worker.progress_updated.connect(self._on_progress_update)
worker.finished.connect(self._on_booking_finished)
```

### 3. 线程安全设计
- 所有阻塞操作在 QThread 中执行
- UI 更新只在主线程进行
- 通过 Qt 信号/槽机制实现线程间通信（自动线程安全）

## 关键技术点

### 1. 异步处理
```python
class BookingWorker(QThread):
    def run(self):
        # 在后台线程执行
        results = self.booking_service.book_scheduled(...)
        # 通过信号返回结果
        self.finished.emit(results)
```

### 2. 任务取消
```python
def cancel(self):
    self._cancelled = True
    # 通知底层 Sniper 停止
    if self.booking_service.sniper:
        self.booking_service.sniper.cancelled = True
    self.requestInterruption()
```

### 3. 实时更新
```python
def on_progress(result: BookingResult):
    if not self._cancelled:
        self.progress_updated.emit(result)
```

### 4. 窗口关闭保护
```python
def closeEvent(self, event):
    if self.booking_worker and self.booking_worker.isRunning():
        # 弹出确认对话框
        reply = QMessageBox.question(...)
        if reply == QMessageBox.StandardButton.No:
            event.ignore()
            return
```

## 数据流

### 抢座流程
```
用户点击"开始抢座"
    ↓
MainWindow._handle_start_booking()
    ↓
创建 BookingWorker
    ↓
BookingWorker.run() (后台线程)
    ↓
BookingService.book_scheduled/book_now()
    ↓
Sniper.book_all()
    ↓
通过回调发送信号
    ↓
MainWindow._on_progress_update() (主线程)
    ↓
更新 UI (日志、状态栏)
    ↓
完成后 MainWindow._on_booking_finished()
    ↓
显示结果对话框
```

### 认证流程
```
用户输入学号密码 → 点击登录
    ↓
MainWindow._handle_login()
    ↓
创建 AuthWorker
    ↓
AuthWorker.run() (后台线程)
    ↓
BrowserAuthService.login_with_credentials()
    ↓
Playwright headless 登录
    ↓
通过信号返回结果
    ↓
MainWindow._on_auth_finished() (主线程)
    ↓
更新 UI、保存凭据
```

## 扩展点

### 1. 自定义组件 (widgets/)
未来可添加：
- `PlanEditDialog`: 方案编辑对话框
- `RoomBrowserWidget`: 房间浏览组件
- `LogWidget`: 增强的日志显示组件
- `StatusIndicator`: 状态指示器

### 2. 配置界面
```python
class SettingsDialog(QDialog):
    """配置对话框：编辑 config.yaml"""
    pass
```

### 3. 系统托盘
```python
from PySide6.QtWidgets import QSystemTrayIcon

class TrayIcon(QSystemTrayIcon):
    """系统托盘图标：最小化到托盘"""
    pass
```

### 4. 主题支持
```python
# 亮色/暗色主题切换
app.setStyleSheet(load_stylesheet("dark"))
```

## 与 CLI 的代码复用

```
┌─────────────────────────────────────┐
│         services/                   │
│  ┌────────────────────────────┐    │
│  │ BookingService             │    │
│  │ PlanService                │    │
│  │ AuthService                │    │
│  │ BrowserAuthService         │    │
│  └────────────────────────────┘    │
└────────────┬───────────────┬────────┘
             │               │
    ┌────────▼──────┐   ┌───▼──────┐
    │  CLI (cli/)   │   │ GUI      │
    │  Interactive  │   │ (gui/)   │
    │  App          │   │ QThread  │
    └───────────────┘   └──────────┘
```

GUI 和 CLI 都依赖同一套 services 层，实现了业务逻辑的完全复用。

## 依赖关系

```
gui/main_window.py
    ├─→ PySide6 (UI 框架)
    ├─→ gui/workers.py (工作线程)
    ├─→ services/* (业务逻辑)
    ├─→ config/settings.py (配置)
    └─→ cli/prompts.py (复用时间解析等工具)

gui/workers.py
    ├─→ PySide6.QtCore (QThread, Signal)
    ├─→ services/booking.py (BookingService)
    └─→ core/sniper/* (BookingPlan, BookingResult)
```

## 性能考虑

1. **延迟加载**: GUI 模块只在 `--gui` 参数时才导入
2. **后台线程**: 避免阻塞主线程导致界面卡顿
3. **信号批量**: 倒计时更新频率限制在 1Hz
4. **日志限制**: 文本框自动滚动，避免无限累积

## 测试建议

### 单元测试
```python
# tests/test_gui_workers.py
def test_booking_worker_cancel():
    worker = BookingWorker(...)
    worker.start()
    worker.cancel()
    assert worker._cancelled == True
```

### 集成测试
```python
# tests/test_gui_integration.py
def test_main_window_startup(qtbot):
    window = MainWindow()
    qtbot.addWidget(window)
    assert window.windowTitle() == "HDU 图书馆抢座工具"
```

### 手动测试清单
- [ ] 启动 GUI 无报错
- [ ] 认证功能正常
- [ ] 方案列表显示正确
- [ ] 立即抢座可执行
- [ ] 定时抢座倒计时准确
- [ ] 取消功能响应及时
- [ ] 日志实时更新
- [ ] 窗口关闭确认对话框
- [ ] 错误处理弹窗正确

## 已知限制

1. **方案管理功能不完整**: 创建/编辑/删除方案需要使用 CLI 模式
2. **配置修改**: 重试参数等配置需要手动编辑 config.yaml
3. **房间浏览**: 暂未实现 GUI 版房间浏览功能
4. **多语言**: 目前只支持中文

## 后续开发计划

### Phase 1: 完善核心功能 ✓
- [x] 认证界面
- [x] 抢座界面
- [x] 方案列表显示
- [x] 异步处理
- [x] 任务取消

### Phase 2: 增强交互 (进行中)
- [ ] 方案创建对话框
- [ ] 方案编辑/删除
- [ ] 房间浏览界面
- [ ] 配置编辑界面

### Phase 3: 用户体验优化
- [ ] 系统托盘集成
- [ ] 主题切换
- [ ] 快捷键支持
- [ ] 记住窗口大小/位置

### Phase 4: 高级特性
- [ ] 历史记录查看
- [ ] 统计分析面板
- [ ] 多账号支持
- [ ] 自动更新检查
