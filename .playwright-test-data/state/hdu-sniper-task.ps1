$ErrorActionPreference = 'Stop'
$logFile = 'C:\Users\zhuhe\Desktop\HDU-Library-Sniper\.playwright-test-data\state\logs\task.log'
$logDir = Split-Path -Parent -Path $logFile
if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
Set-Location -LiteralPath 'C:\Users\zhuhe\Desktop\HDU-Library-Sniper'
$env:HDU_SNIPER_HOME = 'C:\Users\zhuhe\Desktop\HDU-Library-Sniper\.playwright-test-data'
& 'C:\Users\zhuhe\Desktop\HDU-Library-Sniper\.venv\Scripts\python.exe' -m hdu_sniper --run-now *>> $logFile
exit $LASTEXITCODE
