# GUI 界面优化说明

## 优化内容

### 1. 样式系统 (gui/styles.py)

创建了统一的样式系统，包含：

#### 主题色配置
- **主色调**: 蓝色系 (#1976D2)
- **强调色**: 成功绿、警告橙、错误红
- **中性色**: 统一的背景、边框、文字颜色

#### 全局样式 (GLOBAL_STYLE)
- 现代化的控件样式
- 圆角设计 (border-radius: 6-8px)
- 流畅的悬停和按下效果
- 自定义滚动条样式
- 统一的字体和间距

#### 特殊组件样式
- `TITLE_STYLE`: 主标题样式
- `INFO_BOX_STYLE`: 信息提示框（蓝色）
- `SUCCESS_BOX_STYLE`: 成功提示框（绿色）
- `WARNING_BOX_STYLE`: 警告提示框（橙色）
- `ERROR_BOX_STYLE`: 错误提示框（红色）
- `COUNTDOWN_STYLE`: 倒计时显示样式
- `SECTION_TITLE_STYLE`: 章节标题样式

### 2. 主窗口优化 (gui/main_window.py)

#### 整体改进
- 应用全局样式表
- 增加窗口尺寸 (900x700)
- 优化布局间距和边距
- 添加 Emoji 图标增强视觉效果

#### 认证标签页
- 使用 QFormLayout 布局
- 添加说明信息框
- 优化输入框样式和占位符
- 加大登录按钮尺寸

#### 方案管理标签页
- 按钮添加语义化颜色
  - 创建: 绿色（success）
  - 删除: 红色（danger）
  - 其他: 次要样式（secondary）
- 添加 Emoji 图标
- 优化按钮间距

#### 抢座标签页
- 优化表单布局
- 加大主要按钮尺寸
- 改进倒计时显示（带背景色和圆角）
- 倒计时动态显示/隐藏

#### 定时任务标签页
- 统一按钮样式
- 添加语义化颜色
- 优化间距和布局

## 使用方法

### 运行程序
```bash
python main.py
```

### 测试样式导入
```bash
python test_styles.py
```

### 测试 GUI
```bash
python test_gui.py
```

## 设计特点

### 1. Material Design 风格
- 扁平化设计
- 适当的阴影效果
- 流畅的过渡动画

### 2. 色彩语义化
- **蓝色**: 主要操作
- **绿色**: 成功/创建操作
- **红色**: 危险/删除操作
- **橙色**: 警告信息
- **灰色**: 次要操作

### 3. 用户体验优化
- 清晰的视觉层次
- 统一的间距系统
- 响应式的交互反馈
- 信息提示框引导用户

### 4. 可访问性
- 良好的颜色对比度
- 清晰的文字大小
- 直观的图标标识

## 扩展指南

### 添加新按钮样式
在按钮上设置属性：
```python
button = QPushButton("文本")
button.setProperty("success", "true")  # 绿色
button.setProperty("danger", "true")   # 红色
button.setProperty("secondary", "true") # 灰色
```

### 自定义颜色
修改 `gui/styles.py` 中的 `COLORS` 字典：
```python
COLORS = {
    "primary": "#你的颜色",
    # ...
}
```

### 添加新样式
在 `gui/styles.py` 中定义新的样式变量，然后在组件中应用：
```python
MY_STYLE = f"""
    background-color: {COLORS['primary']};
    /* 其他样式 */
"""

# 使用
widget.setStyleSheet(MY_STYLE)
```

## 技术栈

- **GUI 框架**: PySide6 (Qt for Python)
- **样式语言**: QSS (Qt Style Sheets)
- **设计理念**: Material Design
- **字体**: Microsoft YaHei UI / Segoe UI

## 兼容性

- Windows 10/11
- Python 3.10+
- PySide6 6.0+

## 截图

运行程序后可以看到：
- 现代化的标签页设计
- 美观的按钮和输入框
- 清晰的信息提示框
- 流畅的倒计时显示
