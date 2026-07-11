# PowerShell 启动脚本说明

## 🎯 为什么替换 VBScript？

VBScript 已被 Microsoft 正式弃用：
- ❌ **2023年8月**: Microsoft 宣布 VBScript 弃用计划
- ❌ **未来版本**: Windows 将不再内置 VBScript 引擎
- ❌ **安全风险**: 不再接收安全更新
- ✅ **PowerShell**: 现代、安全、功能强大的替代方案

---

## 📁 新的启动方式

### Windows 用户（推荐）

**方法 1: 使用 launch.bat（最简单）**
```
双击 launch.bat 即可静默启动
```

**方法 2: 直接运行 PowerShell**
```powershell
powershell -ExecutionPolicy Bypass -File launch.ps1
```

### 所有平台

**Python 直接启动**
```bash
python main.py
```

---

## 🔧 技术细节

### launch.ps1 (PowerShell 脚本)
- 使用 `pythonw.exe` 避免显示控制台窗口
- 自动设置正确的工作目录
- 现代、安全、跨 Windows 版本兼容

### launch.bat (批处理包装器)
- 绕过 PowerShell 执行策略限制
- 静默运行（`-WindowStyle Hidden`）
- 无需用户手动配置执行策略

---

## ❓ 常见问题

### Q: 为什么需要 launch.bat 包装 launch.ps1？

**A:** PowerShell 默认执行策略可能阻止脚本运行。使用 `.bat` 包装可以：
- ✅ 用户无需修改系统执行策略
- ✅ 使用 `-ExecutionPolicy Bypass` 临时绕过限制
- ✅ 保持安全性（仅对当前脚本生效）

### Q: 可以直接双击 launch.ps1 吗？

**A:** 可以，但可能遇到执行策略错误。解决方案：

**方法 1: 临时允许（推荐）**
```powershell
# 以管理员身份运行 PowerShell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

**方法 2: 使用 launch.bat（更简单）**
```
直接双击 launch.bat，无需配置
```

### Q: 如何验证启动成功？

**A:** 启动后：
1. 打开任务管理器（Ctrl+Shift+Esc）
2. 查找 `pythonw.exe` 进程
3. GUI 窗口应该自动显示

---

## 🔐 安全说明

### PowerShell 执行策略

Windows 执行策略级别：
- `Restricted` - 默认，阻止所有脚本
- `RemoteSigned` - 允许本地脚本，远程脚本需签名
- `Unrestricted` - 允许所有脚本（不推荐）
- `Bypass` - 临时绕过（仅对当前进程）

**我们的方案**：
- ✅ 使用 `Bypass` 仅对启动脚本生效
- ✅ 不修改系统全局执行策略
- ✅ 安全且用户友好

---

## 📊 迁移对比

| 特性 | VBScript | PowerShell |
|------|----------|-----------|
| 维护状态 | ❌ 已弃用 | ✅ 活跃开发 |
| 安全更新 | ❌ 停止 | ✅ 持续更新 |
| 未来兼容性 | ❌ 将被移除 | ✅ 长期支持 |
| 功能丰富度 | ⚠️ 有限 | ✅ 强大 |
| 跨平台 | ❌ 仅 Windows | ✅ 跨平台 |
| 用户体验 | ✅ 简单 | ✅ 简单 |

---

## 🚀 启动流程

```
用户双击 launch.bat
    ↓
调用 PowerShell 绕过执行策略
    ↓
执行 launch.ps1
    ↓
启动 pythonw.exe main.py（隐藏窗口）
    ↓
GUI 显示 ✅
```

---

## 📝 开发者注意事项

如果你是开发者或高级用户，可以：

**选项 1: 永久设置执行策略（推荐 RemoteSigned）**
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

**选项 2: 创建快捷方式**
```powershell
# 创建桌面快捷方式，目标设置为：
powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\path\to\launch.ps1"
```

**选项 3: 使用 Windows Terminal**
```powershell
wt -w 0 nt --title "HDU Sniper" powershell -NoExit -Command "python main.py"
```

---

## ✅ 验证安装

运行以下命令测试：

```powershell
# 测试 PowerShell 脚本
powershell -ExecutionPolicy Bypass -File launch.ps1

# 或直接运行批处理
launch.bat
```

预期结果：
- ✅ 无错误消息
- ✅ GUI 窗口出现
- ✅ 任务管理器中有 `pythonw.exe` 进程

---

## 🎉 总结

从 VBScript 迁移到 PowerShell：
- ✅ 符合 Microsoft 技术路线
- ✅ 更安全、更现代
- ✅ 用户体验保持一致（双击启动）
- ✅ 面向未来的技术选择

**用户无需做任何改变** - 只需双击 `launch.bat` 即可！
