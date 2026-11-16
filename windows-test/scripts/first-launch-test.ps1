# First-launch verification for the MyGo v3 desktop app (run inside the Windows guest).
#
# Simulates a brand-new user: uninstall any previous build, wipe user data
# and WebView2 state, install silently, then launch the app like the Start Menu
# shortcut does (visible window) and check UIA text + SQLite creation.

$ErrorActionPreference = 'Continue'
$share = '\\host.lan\Data'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $share "results\frontend\$stamp"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$log = Join-Path $out 'run.log'

$productName = 'HDU Library Sniper'
$installDir = Join-Path $env:LOCALAPPDATA "Programs\$productName"
$exe = Join-Path $installDir "$productName.exe"
$uninst = Join-Path $installDir 'Uninstall.exe'
$dataDir = Join-Path $env:APPDATA $productName

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

function AppWindowTexts {
  try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
    $p = Get-Process -Name $productName -ErrorAction SilentlyContinue |
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

L "=== first-launch test (MyGo v3) ==="
L ("user={0} share={1}" -f $env:USERNAME, (Test-Path $share))

Get-Process -Name $productName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
if (Test-Path $uninst) {
  $u = Start-Process $uninst -ArgumentList '/S' -Wait -PassThru
  L "uninstall launcher exit=$($u.ExitCode)"
  $deadline = (Get-Date).AddSeconds(40)
  while ((Test-Path $uninst) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
}
if (Test-Path $installDir) {
  Remove-Item -Recurse -Force $installDir -ErrorAction SilentlyContinue
}
Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
Shot '00-clean'

$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process 'C:\OEM\setup.exe' -ArgumentList '/S' -Wait -PassThru
L "install exit=$($p.ExitCode) in $([math]::Round($sw.Elapsed.TotalSeconds,1))s"
Start-Sleep -Seconds 2
L ("installed exe={0} version={1}" -f (Test-Path $exe), (Get-Item $exe -ErrorAction SilentlyContinue).VersionInfo.FileVersion)
Shot '01-installed'

$proc = Start-Process -FilePath $exe -PassThru
L "launched pid=$($proc.Id)"
$sw2 = [Diagnostics.Stopwatch]::StartNew()
foreach ($t in 3, 8, 15, 30) {
  while ($sw2.Elapsed.TotalSeconds -lt $t) { Start-Sleep -Milliseconds 200 }
  $alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
  $title = if ($alive) { $alive.MainWindowTitle } else { '<exited>' }
  L ("t={0}s title={1}" -f $t, $title)
  Shot ("02-launch-$t")
  L ("t={0}s ui: {1}" -f $t, (AppWindowTexts))
}

L ("sniper.db exists: " + (Test-Path (Join-Path $dataDir 'data\sniper.db')))
Shot '03-final'
L "=== done ==="
