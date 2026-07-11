@echo off
REM HDU Library Sniper - Windows 快捷启动脚本
REM 通过 PowerShell 静默启动（绕过执行策略限制）

powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0launch.ps1"
