# First-launch verification for the desktop app (run inside the Windows guest).
#
# Simulates a brand-new user: uninstall any previous build, wipe the user data
# and the WebView2 cache, install the release installer silently, then launch the
# app exactly like the Start Menu shortcut does (no --background).
#
# Writes screenshots + run.log to \\host.lan\Data\results\frontend\<stamp>\.

$ErrorActionPreference = 'Continue'
$share = '\\host.lan\Data'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $share "results\frontend\$stamp"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$log = Join-Path $out 'run.log'

function L([string]$m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Host $line
}

function Shot([string]$n) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing -ErrorAction Stop
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path $out "$n.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    L "shot $n"
  } catch { L "shot $n failed: $_" }
}

function Health {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8000/api/health' -UseBasicParsing -TimeoutSec 2
    return "$($r.StatusCode) $($r.Content)"
  } catch { return "ERR $($_.Exception.Message)" }
}

function AppWindowTexts {
  try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
    $p = Get-Process -Name hdu-library-sniper -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $p) { return '<no visible window>' }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition)
    $names = @()
    foreach ($e in $all) { $n = $e.Current.Name; if ($n) { $names += $n } }
    return (($names | Select-Object -Unique) -join ' | ')
  } catch { return "UIA ERR $_" }
}

L "=== first-launch test ==="
L ("user={0} share={1}" -f $env:USERNAME, (Test-Path $share))

# 1. back to a clean machine ------------------------------------------------
taskkill /F /IM hdu-library-sniper.exe 2>&1 | Out-Null
Start-Sleep -Seconds 2
$uninst = 'C:\Program Files\HDU Library Sniper\uninstall.exe'
if (Test-Path $uninst) {
  $u = Start-Process $uninst -ArgumentList '/S' -Wait -PassThru
  L "uninstall launcher exit=$($u.ExitCode)"
  # NSIS re-launches itself from %TEMP%, so wait for the install dir to go away.
  $deadline = (Get-Date).AddSeconds(40)
  while ((Test-Path $uninst) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  L ("uninstall waited, installDirGone=" + (-not (Test-Path $uninst)))
}
if (Test-Path 'C:\Program Files\HDU Library Sniper') {
  Remove-Item -Recurse -Force 'C:\Program Files\HDU Library Sniper' -ErrorAction SilentlyContinue
  L "removed leftover install dir"
}
Remove-Item -Recurse -Force "$env:USERPROFILE\.hdu-library-sniper" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\io.github.alaichhe.hdu-library-sniper" -ErrorAction SilentlyContinue
L ("clean: installDir={0} userData={1} webviewCache={2}" -f `
    (Test-Path 'C:\Program Files\HDU Library Sniper'), `
    (Test-Path "$env:USERPROFILE\.hdu-library-sniper"), `
    (Test-Path "$env:LOCALAPPDATA\io.github.alaichhe.hdu-library-sniper"))

$inet = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
L ("proxy: Enable={0} Server={1} Override={2}" -f $inet.ProxyEnable, $inet.ProxyServer, $inet.ProxyOverride)
L ("port8000 before install: " + [bool](Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue))
Shot '00-clean'

# 2. install the release installer, silently --------------------------------
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process 'C:\OEM\setup.exe' -ArgumentList '/S' -Wait -PassThru
L "install exit=$($p.ExitCode) in $([math]::Round($sw.Elapsed.TotalSeconds,1))s"
Start-Sleep -Seconds 2
$exe = 'C:\Program Files\HDU Library Sniper\hdu-library-sniper.exe'
L ("installed exe={0} version={1}" -f (Test-Path $exe), (Get-Item $exe -ErrorAction SilentlyContinue).VersionInfo.FileVersion)
L ("processes after install: " + @(Get-Process -Name hdu-library-sniper -ErrorAction SilentlyContinue).Count)
Shot '01-installed'

# 3. launch like the Start Menu shortcut (no --background) -------------------
$proc = Start-Process -FilePath $exe -PassThru
L "launched pid=$($proc.Id) args=<none>"
$sw2 = [Diagnostics.Stopwatch]::StartNew()
foreach ($t in 3, 8, 15, 30, 45) {
  while ($sw2.Elapsed.TotalSeconds -lt $t) { Start-Sleep -Milliseconds 200 }
  $alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
  $title = if ($alive) { $alive.MainWindowTitle } else { '<exited>' }
  L ("t={0}s health={1} title={2}" -f $t, (Health), $title)
  Shot ("02-launch-$t")
  L ("t={0}s ui: {1}" -f $t, (AppWindowTexts))
}

# 4. diagnostics -------------------------------------------------------------
$sf = "$env:USERPROFILE\.hdu-library-sniper\logs\startup.log"
L ("startup.log: " + $(if (Test-Path $sf) { (Get-Content $sf -Raw) } else { '<missing>' }))
$logDir = "$env:LOCALAPPDATA\io.github.alaichhe.hdu-library-sniper\logs"
$gl = @(Get-ChildItem $logDir -Filter *.log -ErrorAction SilentlyContinue)
L ("gui log files: " + (($gl | ForEach-Object { $_.Name }) -join ','))
if ($gl.Count -gt 0) {
  L 'gui log tail:'
  Get-Content $gl[0].FullName -Tail 80 -ErrorAction SilentlyContinue | ForEach-Object { L "  $_" }
}
$conns = @(Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue |
  ForEach-Object { "$($_.State)/pid$($_.OwningProcess)" })
L ("port8000 after launch: " + ($conns -join ','))
L ("user data dir: " + (Test-Path "$env:USERPROFILE\.hdu-library-sniper"))
Shot '03-final'
L "=== done ==="
