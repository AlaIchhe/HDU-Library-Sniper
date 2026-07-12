param(
    [switch]$Execute,
    [string]$AppHome = "",
    [string]$TaskLog = "",
    [string]$WorkDir = "",
    [string]$PythonExe = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent -Path $MyInvocation.MyCommand.Path
$InstallRoot = Split-Path -Parent -Path $ScriptDir

if (-not $WorkDir) {
    $WorkDir = if ($env:SNIPER_WORKDIR) { $env:SNIPER_WORKDIR } else { $InstallRoot }
}
if (-not $PythonExe) {
    $PythonExe = $env:PYTHON_EXE
}
if (-not $PythonExe) {
    foreach ($candidate in @(
        (Join-Path $InstallRoot ".venv\Scripts\python.exe"),
        (Join-Path $InstallRoot "venv\Scripts\python.exe"),
        (Join-Path $InstallRoot "python.exe")
    )) {
        if (Test-Path -Path $candidate -PathType Leaf) {
            $PythonExe = $candidate
            break
        }
    }
}
if (-not $PythonExe) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand) {
        $PythonExe = $pythonCommand.Source
    }
}
if (-not $PythonExe -or -not (Test-Path -Path $PythonExe -PathType Leaf)) {
    Write-Error "No usable Python interpreter was found."
    Exit 7
}

if (-not $TaskLog) {
    $TaskLog = if ($env:SNIPER_TASK_LOG) { $env:SNIPER_TASK_LOG } else { Join-Path $WorkDir "task.log" }
}
$LogDir = Split-Path -Parent -Path $TaskLog

if ($Execute) {
    if ($AppHome) {
        $env:HDU_SNIPER_HOME = $AppHome
    }
    if (-not (Test-Path -Path $LogDir)) {
        New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    }
    Set-Location -Path $WorkDir
    & $PythonExe (Join-Path $WorkDir "main.py") --run-now *>> $TaskLog
    Exit $LASTEXITCODE
}

$DailyAt = if ($env:SNIPER_DAILY_AT) { $env:SNIPER_DAILY_AT } else { "19:59:59" }
$TaskName = if ($env:SNIPER_TASK_NAME) { $env:SNIPER_TASK_NAME } else { "HDU-Library-Sniper-Daily" }
$WakeToRun = if ($env:SNIPER_WAKE_TO_RUN) {
    $env:SNIPER_WAKE_TO_RUN -notin @("0", "false", "False")
} else {
    $true
}

try {
    $Trigger = New-ScheduledTaskTrigger -Daily -At $DailyAt
} catch {
    Write-Error "Invalid scheduled time: '$DailyAt'."
    Exit 4
}

if (-not (Test-Path -Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$ActionArgument = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"' +
    ' -Execute -TaskLog "' + $TaskLog + '"' +
    ' -WorkDir "' + $WorkDir + '"' +
    ' -PythonExe "' + $PythonExe + '"'
if ($env:HDU_SNIPER_HOME) {
    $ActionArgument += ' -AppHome "' + $env:HDU_SNIPER_HOME + '"'
}

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument $ActionArgument `
    -WorkingDirectory $WorkDir

$CurrentUserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$Principal = New-ScheduledTaskPrincipal `
    -UserId $CurrentUserId `
    -LogonType Interactive `
    -RunLevel Limited

$SettingsParams = @{
    AllowStartIfOnBatteries = $true
    DontStopIfGoingOnBatteries = $true
    StartWhenAvailable = $true
}
if ($WakeToRun) {
    $SettingsParams.WakeToRun = $true
}
$TaskSettings = New-ScheduledTaskSettingsSet @SettingsParams
$Description = "Run HDU-Library-Sniper daily at $DailyAt"

Register-ScheduledTask `
    -TaskName $TaskName `
    -Description $Description `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $TaskSettings `
    -Force | Out-Null

Write-Host ('Scheduled task {0} created for {1} daily.' -f $TaskName, $DailyAt)
Write-Host ('Run as: {0}' -f $CurrentUserId)
Write-Host ('App home: {0}' -f $env:HDU_SNIPER_HOME)
Write-Host ('Task log: {0}' -f $TaskLog)
