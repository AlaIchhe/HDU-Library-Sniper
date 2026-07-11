# 代码规范修复指南

**目标**: 消除项目中所有非 ASCII 字符命名和冗余启动脚本

---

## 📋 问题分析

### ✅ Python 代码质量（优秀）
扫描结果：**37 个 Python 文件，0 个命名问题**
- ✅ 所有变量、函数、类名都使用英文
- ✅ 严格遵守 PEP 8 规范
- ✅ 完整的类型注解

### ⚠️ 需要修复的问题

#### 1. 非 ASCII 文件名（1个）
- `HDU图书馆抢座.vbs` → 需要重命名为 `launch.vbs`

#### 2. 冗余启动脚本（2个）
- `start.bat` - 与 VBS 功能重复
- `start.sh` - 价值有限

---

## 🔧 修复步骤

### 步骤 1: 重命名 VBS 文件（必须）

```bash
# 使用 git mv 保留历史
cd HDU-Library-Sniper
git mv "HDU图书馆抢座.vbs" launch.vbs
```

**或使用 Windows 命令：**
```cmd
cd HDU-Library-Sniper
ren "HDU图书馆抢座.vbs" launch.vbs
git add launch.vbs
git add "HDU图书馆抢座.vbs"
```

### 步骤 2: 删除冗余脚本（推荐）

**选项 A: 直接删除**
```bash
git rm start.bat start.sh
```

**选项 B: 归档保留（保守方案）**
```bash
mkdir -p scripts/legacy
git mv start.bat start.sh scripts/legacy/
```

### 步骤 3: 更新文档

README.md 已更新：
- ✅ 移除了 `start.bat` 和 `start.sh` 的引用
- ✅ 将 `HDU图书馆抢座.vbs` 改为 `launch.vbs`

### 步骤 4: 提交修改

```bash
git status  # 确认修改
git commit -m "代码规范：重命名非ASCII文件名并清理冗余脚本

- 重命名 HDU图书馆抢座.vbs → launch.vbs（消除中文文件名）
- 删除冗余的 start.bat 和 start.sh
- 更新 README.md 启动说明"
```

---

## 📊 修复前后对比

### 启动入口精简

**修复前（4个入口）：**
```
├── main.py               # Python 入口
├── HDU图书馆抢座.vbs     # VBS 静默启动（中文文件名 ⚠️）
├── start.bat             # Windows 批处理（冗余）
└── start.sh              # Linux Shell（冗余）
```

**修复后（2个入口）：**
```
├── main.py               # Python 入口 ✅
└── launch.vbs            # VBS 静默启动 ✅
```

### 代码规范达标

| 检查项 | 修复前 | 修复后 |
|--------|--------|--------|
| 中文变量名 | 0 ✅ | 0 ✅ |
| 中文函数名 | 0 ✅ | 0 ✅ |
| 中文类名 | 0 ✅ | 0 ✅ |
| 中文文件名 | 1 ⚠️ | 0 ✅ |
| 冗余入口 | 2 ⚠️ | 0 ✅ |

---

## 🎯 为什么要修复

### 1. 跨平台兼容性
中文文件名在不同操作系统/文件系统上可能导致：
- 编码问题（UTF-8 vs GBK）
- 版本控制冲突
- CI/CD 构建失败

### 2. 代码可维护性
冗余入口导致：
- 维护负担（4个文件都要同步更新）
- 用户困惑（不知道该用哪个）
- 测试成本增加

### 3. 行业规范
- PEP 8 明确建议使用 ASCII 字符
- GitHub/GitLab 等平台最佳实践
- 团队协作标准

---

## ✅ 验证修复

执行以下命令验证：

```bash
# 1. 检查是否还有中文文件名
find . -name "*[一-龥]*" -type f

# 2. 确认新文件存在
ls -la launch.vbs

# 3. 确认冗余脚本已删除
ls -la start.bat start.sh 2>&1 | grep "No such file"

# 4. 测试启动
python main.py  # 应正常启动 GUI
```

---

## 📝 注意事项

### 关于 VBScript
虽然 VBScript 已被 Microsoft 标记为弃用，但对于这个项目：
- ✅ **保留**: 提供 Windows 静默启动的用户体验
- ✅ **重命名**: 使用英文文件名
- ❓ **未来**: 可以考虑用 PowerShell 替代（但非紧急）

### 如果你想替换 VBScript
可以创建 `launch.ps1`：
```powershell
# launch.ps1
Start-Process pythonw -ArgumentList "main.py" -WindowStyle Hidden
```

然后创建快捷方式：
```cmd
powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File launch.ps1
```

---

## 🚀 快速执行

**一键执行所有修复（复制粘贴）：**

```bash
cd HDU-Library-Sniper

# 重命名 VBS
git mv "HDU图书馆抢座.vbs" launch.vbs

# 删除冗余脚本
git rm start.bat start.sh

# 检查状态
git status

# 提交
git commit -m "代码规范：重命名非ASCII文件名并清理冗余脚本"
```

---

## 📈 项目质量提升

这次修复将使项目：
- ✅ 完全符合 PEP 8 和行业规范
- ✅ 跨平台兼容性更好
- ✅ 维护成本更低
- ✅ 用户体验更清晰

**总结**: 小改动，大提升！这是一个本来就很优秀的项目，现在变得更加专业和规范。
