"""测试样式模块导入。"""

import sys
from pathlib import Path

# 添加项目根目录到路径
sys.path.insert(0, str(Path(__file__).parent))

try:
    from gui.styles import (
        GLOBAL_STYLE,
        TITLE_STYLE,
        INFO_BOX_STYLE,
        COUNTDOWN_STYLE,
        SECTION_TITLE_STYLE,
        COLORS,
    )

    print("✓ 样式模块导入成功！")
    print(f"\n主题色配置:")
    for key, value in COLORS.items():
        print(f"  {key}: {value}")

    print(f"\n全局样式长度: {len(GLOBAL_STYLE)} 字符")
    print(f"标题样式长度: {len(TITLE_STYLE)} 字符")
    print(f"信息框样式长度: {len(INFO_BOX_STYLE)} 字符")

except Exception as e:
    print(f"✗ 导入失败: {e}")
    import traceback
    traceback.print_exc()
