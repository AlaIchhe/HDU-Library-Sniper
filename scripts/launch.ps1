# HDU Library Sniper - PowerShell 启动脚本
# 静默启动 GUI，无命令行窗口

# 使用 pythonw.exe 避免显示控制台窗口
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
Start-Process -FilePath "pythonw.exe" -ArgumentList "main.py" -WorkingDirectory $projectRoot -WindowStyle Hidden
