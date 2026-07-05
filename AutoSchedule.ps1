# ==============================================================================
# 0. 环境校验（关键错误尽早致命，避免注册到任务计划后静默失败）
# ==============================================================================

# 自动定位脚本所在目录，不管用户在哪个目录运行都正确
$ScriptDir = Split-Path -Parent -Path $MyInvocation.MyCommand.Path

# 优先读 PYTHON_EXE 环境变量，找不到则从 PATH 查找 `python` / `python3`
if ($env:PYTHON_EXE) {
    $pythonCandidates = @($env:PYTHON_EXE)
} else {
    $pythonCandidates = @("python3", "python")
}

$PythonExe = $null
foreach ($cand in $pythonCandidates) {
    $cmd = Get-Command $cand -ErrorAction SilentlyContinue
    if ($cmd) {
        $PythonExe = $cmd.Source
        break
    }
}

if (-not $PythonExe) {
    Write-Error "❌ 未找到 Python。请先在系统 PATH 中安装 Python，或设置环境变量 PYTHON_EXE 指向 python.exe 的绝对路径。例如:`n  [System.Environment]::SetEnvironmentVariable('PYTHON_EXE', 'C:\Python313\python.exe', 'User')"
    Exit 7
}

# ==============================================================================
# 1. 配置（全部从环境变量读取，缺省值在本机生效；他人只需改一次 env）
# ==============================================================================

# 工作目录：优先 SNIPER_WORKDIR，否则脚本所在目录
$WorkDir    = if ($env:SNIPER_WORKDIR) { $env:SNIPER_WORKDIR } else { $ScriptDir }
$LogDir     = Join-Path $WorkDir "logs"
$LogHistory = if ($env:SNIPER_LOG_HISTORY) { [int]$env:SNIPER_LOG_HISTORY } else { 30 }
# 默认每天 19:59 触发，他人可设 SNIPER_DAILY_AT 覆盖
$DailyAt    = if ($env:SNIPER_DAILY_AT) { $env:SNIPER_DAILY_AT } else { "07:59PM" }
$TaskName   = if ($env:SNIPER_TASK_NAME) { $env:SNIPER_TASK_NAME } else { "HDU-Library-Sniper-Daily" }
# 是否让任务唤醒睡眠中的计算机（缺省 true）
$WakeToRun  = if ($null -ne $env:SNIPER_WAKE_TO_RUN) { $env:SNIPER_WAKE_TO_RUN -ne "false" } else { $true }

# ==============================================================================
# 2. 核心执行逻辑（对应原 .bat 脚本）
# ==============================================================================

if ($args -contains "-Execute") {
    Set-Location -Path $WorkDir

    if (-not (Test-Path -Path $LogDir)) {
        New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    }

    $LogFile = Join-Path $LogDir "task_log.txt"
    # 日志轮转：限制大小，避免无限增长
    if (Test-Path $LogFile) {
        $size = (Get-Item $LogFile).Length
        if ($size -gt 5MB) {
            $backup = Join-Path $LogDir "task_log_$(Get-Date -Format 'yyyyMMddHHmmss').txt"
            Move-Item $LogFile $backup -Force
            Get-ChildItem $LogDir -Filter "task_log_*.txt" |
                Sort-Object LastWriteTime -Descending |
                Select-Object -Skip $LogHistory |
                Remove-Item -Force
        }
    }

    $CurrentTime = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$CurrentTime] 开始运行 HDU-Library-Sniper (Python: $PythonExe)..." | Add-Content -Path $LogFile

    & $PythonExe "main.py" --run-now *>> $LogFile
    if ($LASTEXITCODE -ne 0) {
        "[$CurrentTime] ⚠️ Python 退出码 $LASTEXITCODE（非 0）" | Add-Content -Path $LogFile
    }

    "--------------------------------------------------" | Add-Content -Path $LogFile
    Exit
}

# ==============================================================================
# 3. 自动注册到 Windows 任务计划程序（每晚约定时间触发）
# ==============================================================================

$Description  = "自动运行 HDU-Library-Sniper 守护脚本，每日 $DailyAt 触发"
$ScriptPath   = $MyInvocation.MyCommand.Path

try {
    $Trigger = New-ScheduledTaskTrigger -Daily -At $DailyAt
} catch {
    Write-Error "❌ 无法创建任务触发器：$DailyAt 不是有效时间格式，请使用如 '07:59PM' 的格式。"
    Exit 4
}

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -File `"$ScriptPath`" -Execute"

$Principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest

$SettingsParams = @{
    AllowStartIfOnBatteries = $true
    DontStopIfGoingOnBatteries = $true
    StartWhenAvailable = $true
}
if ($WakeToRun) {
    $SettingsParams.WakeToRun = $true
}
$Settings = New-ScheduledTaskSettingsSet @SettingsParams

Register-ScheduledTask -TaskName $TaskName -Description $Description -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force

Write-Host "✅ 任务计划 '$TaskName' 已创建，每日 $DailyAt 自动触发。" -ForegroundColor Green
Write-Host "   工作目录 : $WorkDir"
Write-Host "   日志目录 : $LogDir"
Write-Host "   Python   : $PythonExe"
Write-Host ""
Write-Host "他人使用方式：把本文件夹拷到任意路径，双击或运行 .\\AutoSchedule.ps1 即可。" -ForegroundColor Cyan
Write-Host "可选环境变量（注册/系统级）：" -ForegroundColor DarkGray
Write-Host "   SNIPER_WORKDIR     自定义工作目录（缺省=脚本所在目录）"
Write-Host "   PYTHON_EXE         自定义 python.exe 路径（缺省=PATH 中的 python）"
Write-Host "   SNIPER_DAILY_AT    自定义触发时间（缺省 07:59PM）"
Write-Host "   SNIPER_TASK_NAME   自定义任务计划名称（缺省 HDU-Library-Sniper-Daily）"
Write-Host ""
Write-Host "⚡ 唤醒与电源（默认已 -WakeToRun）：笔记本睡眠状态可被 BIOS 唤醒。" -ForegroundColor Yellow
Write-Host "   若你每次都彻底关机断电，任务仍不会跑 → 永远用 [每日自动执行] 一条即可。"
Write-Host "   若想延长唤醒窗口或禁用唤醒，可环境变量覆盖：" -ForegroundColor DarkGray
Write-Host "   SNIPER_WAKE_TO_RUN=true|false（缺省 true）" -ForegroundColor DarkGray
