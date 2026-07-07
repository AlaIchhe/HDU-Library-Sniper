# ==============================================================================
# 0. 环境校验（关键错误尽早致命，避免注册到任务计划后静默失败）
# ==============================================================================

# 自动定位脚本所在目录，不管用户在哪个目录运行都正确
$ScriptDir = Split-Path -Parent -Path $MyInvocation.MyCommand.Path

# ------------------------------------------------------------------------------
# Python 解析器定位：优先“锁定本地” pythonw.exe，写入 Action 的是绝对路径。
# 原因：任务以 NT AUTHORITY\SYSTEM 运行，其 PATH 通常不含用户安装的 Python，
#       若靠 PATH 解析会静默失败。故优先在脚本目录 / 本地 venv 查找 pythonw.exe，
#       再退回 PYTHON_EXE 环境变量与 PATH，确保 SYSTEM 账户也能找到。
# ------------------------------------------------------------------------------
function Find-PythonExecutable {
    param([string]$BaseDir)

    # 1) 本地脚本目录及常见虚拟环境子目录（最优先，“锁定本地”）
    $localCandidates = @(
        (Join-Path $BaseDir "pythonw.exe"),
        (Join-Path $BaseDir ".venv\Scripts\pythonw.exe"),
        (Join-Path $BaseDir "venv\Scripts\pythonw.exe"),
        (Join-Path $BaseDir "python\pythonw.exe")
    )
    foreach ($p in $localCandidates) {
        if (Test-Path -Path $p -PathType Leaf) { return $p }
    }

    # 2) PYTHON_EXE 环境变量（可能指向 python.exe 或 pythonw.exe）
    if ($env:PYTHON_EXE -and (Test-Path -Path $env:PYTHON_EXE -PathType Leaf)) {
        $dir = Split-Path -Parent -Path $env:PYTHON_EXE
        $pw = Join-Path $dir "pythonw.exe"
        if (Test-Path -Path $pw -PathType Leaf) { return $pw }
        if ($env:PYTHON_EXE -match 'pythonw\.exe$') { return $env:PYTHON_EXE }
    }

    # 3) PATH 中的 pythonw / python3 / python（取同目录 pythonw.exe，锁定绝对路径）
    foreach ($name in @("pythonw", "python3", "python")) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) {
            $dir = Split-Path -Parent -Path $cmd.Source
            $pw = Join-Path $dir "pythonw.exe"
            if (Test-Path -Path $pw -PathType Leaf) { return $pw }
        }
    }
    return $null
}

$PythonWExe = Find-PythonExecutable -BaseDir $ScriptDir
if (-not $PythonWExe) {
    Write-Error "❌ 未找到 pythonw.exe。任务以 SYSTEM 账户运行时 PATH 不可靠，必须锁定本地绝对路径。"
    Write-Host "   解决方法（任选其一）：" -ForegroundColor Yellow
    Write-Host "   (a) 把 pythonw.exe 放到脚本目录：$ScriptDir" -ForegroundColor Yellow
    Write-Host "   (b) 设置环境变量 PYTHON_EXE 指向 python.exe 绝对路径，例如：" -ForegroundColor Yellow
    Write-Host "       [System.Environment]::SetEnvironmentVariable('PYTHON_EXE', 'C:\Python313\python.exe', 'User')" -ForegroundColor Yellow
    Exit 7
}

# python.exe（有 stdout，供下方 -Execute 日志重定向模式使用；pythonw.exe 无 stdout）
$pythonDir = Split-Path -Parent -Path $PythonWExe
$PythonExe = Join-Path $pythonDir "python.exe"
if (-not (Test-Path -Path $PythonExe -PathType Leaf)) { $PythonExe = $PythonWExe }

# ==============================================================================
# 1. 配置（全部从环境变量读取，缺省值在本机生效；他人只需改一次 env）
# ==============================================================================

# 工作目录：优先 SNIPER_WORKDIR，否则脚本所在目录（本地锁定，确保 data/ logs/ 相对路径可解析）
$WorkDir    = if ($env:SNIPER_WORKDIR) { $env:SNIPER_WORKDIR } else { $ScriptDir }
$LogDir     = Join-Path $WorkDir "logs"
$LogHistory = if ($env:SNIPER_LOG_HISTORY) { [int]$env:SNIPER_LOG_HISTORY } else { 30 }
# 默认每天 19:59:59 触发，他人可设 SNIPER_DAILY_AT 覆盖
$DailyAt    = if ($env:SNIPER_DAILY_AT) { $env:SNIPER_DAILY_AT } else { "19:59:59" }
$TaskName   = if ($env:SNIPER_TASK_NAME) { $env:SNIPER_TASK_NAME } else { "HDU-Library-Sniper-Daily" }
# 是否让任务唤醒睡眠中的计算机（缺省 true）
$WakeToRun  = if ($null -ne $env:SNIPER_WAKE_TO_RUN) { $env:SNIPER_WAKE_TO_RUN -ne "false" } else { $true }

# ==============================================================================
# 2. 可选的日志包装模式（-Execute）
#    默认任务 Action 直接 `pythonw main.py --run-now`（无窗口，日志由 main.py 的
#    Notifier 写入 config.yaml 的 paths.log_file）。若想要 stdout 重定向 + 滚动
#    归档，可手动以 `powershell -File AutoSchedule.ps1 -Execute` 运行本分支。
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
# 3. 自动注册到 Windows 任务计划程序（每晚 19:59:59 触发）
# ==============================================================================

# SYSTEM 账户注册需要管理员权限，提前校验，避免 Register-ScheduledTask 失败
$currentUser = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentUser.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    Write-Error "❌ 注册到 SYSTEM 账户需要管理员权限。请用管理员身份打开 PowerShell 后重新运行本脚本。"
    Exit 5
}

$Description = "自动运行 HDU-Library-Sniper，每日 $DailyAt 触发（pythonw main.py --run-now）"

# 解析触发时间（支持 "19:59:59" / "07:59PM" 等格式）
try {
    $Trigger = New-ScheduledTaskTrigger -Daily -At $DailyAt
} catch {
    Write-Error "❌ 无法创建任务触发器：'$DailyAt' 不是有效时间格式，请使用如 '19:59:59' 或 '07:59PM' 的格式。"
    Exit 4
}

# Action：直接用 pythonw.exe 绝对路径执行 main.py --run-now，无窗口、不依赖 SYSTEM 的 PATH；
# WorkingDirectory 锁定为脚本所在目录，确保 data/ logs/ config/ 相对路径在 SYSTEM 下可解析。
$Action = New-ScheduledTaskAction `
    -Execute $PythonWExe `
    -Argument "main.py --run-now" `
    -WorkingDirectory $WorkDir

# 不管用户是否登录都要运行：SYSTEM 服务账户 + 最高权限
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

Register-ScheduledTask -TaskName $TaskName -Description $Description -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null

Write-Host "✅ 任务计划 '$TaskName' 已创建，每日 $DailyAt 自动触发。" -ForegroundColor Green
Write-Host "   工作目录 : $WorkDir"
Write-Host "   Python   : $PythonWExe"
Write-Host "   操作     : pythonw main.py --run-now"
Write-Host "   运行身份 : NT AUTHORITY\SYSTEM（不管用户是否登录都要运行）"
Write-Host ""
Write-Host "他人使用方式：把本文件夹拷到任意路径，以管理员身份运行 .\AutoSchedule.ps1 即可。" -ForegroundColor Cyan
Write-Host "可选环境变量（注册/系统级）：" -ForegroundColor DarkGray
Write-Host "   SNIPER_WORKDIR     自定义工作目录（缺省=脚本所在目录）"
Write-Host "   PYTHON_EXE         自定义 python.exe / pythonw.exe 路径（缺省=本地优先 + PATH）"
Write-Host "   SNIPER_DAILY_AT    自定义触发时间（缺省 19:59:59）"
Write-Host "   SNIPER_TASK_NAME   自定义任务计划名称（缺省 HDU-Library-Sniper-Daily）"
Write-Host "   SNIPER_LOG_HISTORY 仅 -Execute 模式生效的归档日志保留数（缺省 30）"
Write-Host ""
Write-Host "⚡ 唤醒与电源（默认已 -WakeToRun）：笔记本睡眠状态可被 BIOS 唤醒。" -ForegroundColor Yellow
Write-Host "   若你每次都彻底关机断电，任务仍不会跑 → 永远用 [每日自动执行] 一条即可。"
Write-Host "   若想禁用唤醒，可环境变量覆盖：SNIPER_WAKE_TO_RUN=false" -ForegroundColor DarkGray
Write-Host ""
Write-Host "📝 日志：默认模式由 main.py 写入 config.yaml 的 paths.log_file（logs/booking.log）。" -ForegroundColor DarkGray
Write-Host "   若需 stdout 重定向 + 滚动归档，可手动改用 -Execute 模式（见脚本第 2 节）。"
