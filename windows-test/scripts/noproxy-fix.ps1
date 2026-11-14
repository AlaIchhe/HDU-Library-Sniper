# Validate the proposed fix: NO_PROXY covering loopback makes plugin-http skip
# the (dead) WinINET proxy, so the startup probe reaches the local backend even
# when ProxyEnable=1 points at a dead port and ProxyOverride has no bypass.
#
# The app reads NO_PROXY the way any reqwest client does; setting it in the
# parent process here is equivalent to the Rust side calling env::set_var early.

$ErrorActionPreference = 'Continue'
$share = '\\host.lan\Data'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $share "results\frontend\noproxy-fix-$stamp"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$log = Join-Path $out 'run.log'
$exe = 'C:\Program Files\HDU Library Sniper\hdu-library-sniper.exe'
$inet = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'

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
function UiaText {
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
function KillApp { taskkill /F /IM hdu-library-sniper.exe 2>&1 | Out-Null; Start-Sleep -Seconds 2 }

L '=== NO_PROXY fix validation ==='
KillApp
Set-ItemProperty $inet -Name ProxyEnable -Value 1 -Type DWord
Set-ItemProperty $inet -Name ProxyServer -Value '127.0.0.1:9'
Set-ItemProperty $inet -Name ProxyOverride -Value ''
L 'dead proxy enabled, no override'

# 1. control: no NO_PROXY -> probe must fail
Remove-Item Env:NO_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:no_proxy -ErrorAction SilentlyContinue
Start-Process -FilePath $exe | Out-Null
Start-Sleep -Seconds 12
L ("control (no NO_PROXY): {0}" -f (UiaText))
Shot 'control'
KillApp

# 2. fix: NO_PROXY covering loopback -> login page must render
$env:NO_PROXY = '127.0.0.1,localhost,::1'
$env:no_proxy = '127.0.0.1,localhost,::1'
Start-Process -FilePath $exe | Out-Null
Start-Sleep -Seconds 12
L ("with NO_PROXY: {0}" -f (UiaText))
Shot 'with-noproxy'
KillApp

Remove-Item Env:NO_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:no_proxy -ErrorAction SilentlyContinue
Set-ItemProperty $inet -Name ProxyEnable -Value 0 -Type DWord
Set-ItemProperty $inet -Name ProxyServer -Value '' -Type String
$p = Get-ItemProperty $inet
L ("proxy restored: Enable={0} Server='{1}'" -f $p.ProxyEnable, $p.ProxyServer)
L '=== done ==='
