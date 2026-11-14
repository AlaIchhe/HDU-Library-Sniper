# Which WinINET proxy configurations break the localhost API probe?
#
# With a dead proxy at 127.0.0.1:9 we try three ProxyOverride values:
#   "127.*;localhost" -> expected to bypass 127.0.0.1 and work
#   "<local>"         -> the WinINET "bypass plain hostnames" token
#   ""                -> no bypass at all
# The UI text tells the story: login page = reachable, 正在启动/较慢 = proxied.

$ErrorActionPreference = 'Continue'
$share = '\\host.lan\Data'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $share "results\frontend\proxybypass-$stamp"
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
function Verdict {
  $t = UiaText
  if ($t -match '登录图书馆账户') { return 'REACHABLE' }
  if ($t -match '启动失败') { return 'FAILED' }
  if ($t -match '较慢') { return 'SLOW_SPINNER' }
  if ($t -match '正在启动本地服务') { return 'SPINNER' }
  return "OTHER: $t"
}
function KillApp { taskkill /F /IM hdu-library-sniper.exe 2>&1 | Out-Null; Start-Sleep -Seconds 2 }

function TestVariant([string]$name, [string]$override) {
  L "--- $name (ProxyOverride='$override') ---"
  KillApp
  Set-ItemProperty $inet -Name ProxyEnable -Value 1 -Type DWord
  Set-ItemProperty $inet -Name ProxyServer -Value '127.0.0.1:9'
  Set-ItemProperty $inet -Name ProxyOverride -Value $override -Type String
  Start-Process -FilePath $exe | Out-Null
  Start-Sleep -Seconds 12
  L ("  verdict={0}" -f (Verdict))
  Shot $name
  L ("  ui: {0}" -f (UiaText))
  KillApp
}

L '=== proxy bypass variants ==='
TestVariant 'bypass-127star' '127.*;localhost'
TestVariant 'bypass-local-tag' '<local>'
TestVariant 'bypass-empty' ''
Set-ItemProperty $inet -Name ProxyEnable -Value 0 -Type DWord
Set-ItemProperty $inet -Name ProxyServer -Value '' -Type String
Set-ItemProperty $inet -Name ProxyOverride -Value '' -Type String
$p = Get-ItemProperty $inet
L ("proxy restored: Enable={0} Server='{1}' Override='{2}'" -f $p.ProxyEnable, $p.ProxyServer, $p.ProxyOverride)
L '=== done ==='
