"""HDU 图书馆抢座工具 GUI 样式定义。"""

# 主题色配置
COLORS = {
    # 主色调 - 蓝色系
    "primary": "#1976D2",
    "primary_light": "#42A5F5",
    "primary_dark": "#1565C0",
    # 强调色
    "accent": "#FF6F00",
    "success": "#4CAF50",
    "warning": "#FF9800",
    "error": "#F44336",
    "info": "#2196F3",
    # 中性色
    "background": "#FFFFFF",
    "surface": "#F5F5F5",
    "border": "#E0E0E0",
    "text_primary": "#212121",
    "text_secondary": "#757575",
    "text_disabled": "#BDBDBD",
    # 阴影
    "shadow": "rgba(0, 0, 0, 0.1)",
}

# 全局样式表
GLOBAL_STYLE = f"""
/* 全局字体 */
QWidget {{
    font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif;
    font-size: 10pt;
}}

/* 主窗口 */
QMainWindow {{
    background-color: {COLORS["surface"]};
}}

/* Tab 控件 */
QTabWidget::pane {{
    border: 1px solid {COLORS["border"]};
    border-radius: 8px;
    background-color: {COLORS["background"]};
    padding: 16px;
}}

QTabBar::tab {{
    background-color: {COLORS["surface"]};
    color: {COLORS["text_secondary"]};
    padding: 10px 20px;
    margin-right: 4px;
    border: 1px solid {COLORS["border"]};
    border-bottom: none;
    border-top-left-radius: 8px;
    border-top-right-radius: 8px;
    min-width: 100px;
}}

QTabBar::tab:selected {{
    background-color: {COLORS["background"]};
    color: {COLORS["primary"]};
    border-color: {COLORS["border"]};
    border-bottom: 2px solid {COLORS["primary"]};
    font-weight: bold;
}}

QTabBar::tab:hover:!selected {{
    background-color: {COLORS["primary_light"]};
    color: white;
}}

/* 按钮样式 */
QPushButton {{
    background-color: {COLORS["primary"]};
    color: white;
    border: none;
    border-radius: 6px;
    padding: 10px 20px;
    font-weight: bold;
    min-height: 32px;
}}

QPushButton:hover {{
    background-color: {COLORS["primary_light"]};
}}

QPushButton:pressed {{
    background-color: {COLORS["primary_dark"]};
}}

QPushButton:disabled {{
    background-color: {COLORS["border"]};
    color: {COLORS["text_disabled"]};
}}

/* 次要按钮 */
QPushButton[secondary="true"] {{
    background-color: {COLORS["surface"]};
    color: {COLORS["text_primary"]};
    border: 1px solid {COLORS["border"]};
}}

QPushButton[secondary="true"]:hover {{
    background-color: {COLORS["border"]};
}}

/* 危险按钮 */
QPushButton[danger="true"] {{
    background-color: {COLORS["error"]};
}}

QPushButton[danger="true"]:hover {{
    background-color: #E53935;
}}

/* 成功按钮 */
QPushButton[success="true"] {{
    background-color: {COLORS["success"]};
}}

QPushButton[success="true"]:hover {{
    background-color: #66BB6A;
}}

/* 输入框 */
QLineEdit {{
    background-color: white;
    border: 2px solid {COLORS["border"]};
    border-radius: 6px;
    padding: 8px 12px;
    min-height: 32px;
}}

QLineEdit:focus {{
    border-color: {COLORS["primary"]};
}}

QLineEdit:disabled {{
    background-color: {COLORS["surface"]};
    color: {COLORS["text_disabled"]};
}}

/* 文本编辑器 */
QTextEdit {{
    background-color: white;
    border: 1px solid {COLORS["border"]};
    border-radius: 6px;
    padding: 12px;
}}

QTextEdit:focus {{
    border-color: {COLORS["primary"]};
}}

/* 标签 */
QLabel {{
    color: {COLORS["text_primary"]};
}}

/* 状态栏 */
QStatusBar {{
    background-color: {COLORS["surface"]};
    color: {COLORS["text_secondary"]};
    border-top: 1px solid {COLORS["border"]};
    padding: 4px;
}}

/* 分组框 */
QGroupBox {{
    background-color: white;
    border: 1px solid {COLORS["border"]};
    border-radius: 8px;
    margin-top: 12px;
    padding: 16px;
    font-weight: bold;
}}

QGroupBox::title {{
    subcontrol-origin: margin;
    subcontrol-position: top left;
    padding: 4px 12px;
    color: {COLORS["primary"]};
}}

/* 滚动条 */
QScrollBar:vertical {{
    background-color: {COLORS["surface"]};
    width: 12px;
    border-radius: 6px;
}}

QScrollBar::handle:vertical {{
    background-color: {COLORS["border"]};
    border-radius: 6px;
    min-height: 30px;
}}

QScrollBar::handle:vertical:hover {{
    background-color: {COLORS["text_disabled"]};
}}

QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{
    height: 0px;
}}

QScrollBar:horizontal {{
    background-color: {COLORS["surface"]};
    height: 12px;
    border-radius: 6px;
}}

QScrollBar::handle:horizontal {{
    background-color: {COLORS["border"]};
    border-radius: 6px;
    min-width: 30px;
}}

QScrollBar::handle:horizontal:hover {{
    background-color: {COLORS["text_disabled"]};
}}

QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {{
    width: 0px;
}}

/* 消息框 */
QMessageBox {{
    background-color: white;
}}

QMessageBox QPushButton {{
    min-width: 80px;
}}
"""

# 特殊组件样式
TITLE_STYLE = f"""
font-size: 24pt;
font-weight: bold;
color: {COLORS["primary"]};
padding: 20px;
background-color: white;
border-radius: 8px;
margin-bottom: 16px;
"""

INFO_BOX_STYLE = f"""
background-color: #E3F2FD;
border-left: 4px solid {COLORS["info"]};
border-radius: 6px;
padding: 12px;
color: {COLORS["text_primary"]};
"""

COUNTDOWN_STYLE = f"""
font-size: 18pt;
font-weight: bold;
color: {COLORS["primary"]};
background-color: #E3F2FD;
border-radius: 8px;
padding: 16px;
"""

SECTION_TITLE_STYLE = f"""
font-size: 11pt;
font-weight: bold;
color: {COLORS["primary"]};
padding: 8px 0px;
"""
