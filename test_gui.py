# -*- coding: utf-8 -*-
"""GUI 模块测试：验证导入和基本结构。"""

import sys

def test_imports():
    """测试 GUI 模块能否正常导入。"""
    try:
        # 测试核心模块导入
        from gui.workers import BookingWorker, AuthWorker
        print("[OK] workers 模块导入成功")

        from gui.main_window import MainWindow
        print("[OK] main_window 模块导入成功")

        from gui.app import run_gui
        print("[OK] app 模块导入成功")

        print("\n所有 GUI 模块导入成功！")
        return True

    except ImportError as exc:
        print(f"[FAIL] 导入失败: {exc}")
        return False
    except Exception as exc:
        print(f"[FAIL] 其他错误: {exc}")
        return False


if __name__ == "__main__":
    # 检查 PySide6 是否安装
    try:
        import PySide6
        print(f"[OK] PySide6 已安装 (版本 {PySide6.__version__})\n")
    except ImportError:
        print("[FAIL] PySide6 未安装，正在安装...")
        import subprocess
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "PySide6"])
            print("[OK] PySide6 安装完成\n")
        except subprocess.CalledProcessError:
            print("[FAIL] PySide6 安装失败，请手动运行: pip install PySide6\n")
            sys.exit(1)

    test_imports()
