# Reproduces the two residual "frontend up / backend down" failure modes on Windows:
#
#   A. port 8000 is already taken -> the app's own start_api() bind fails, the UI
#      is expected to hang on "正在启动本地服务…" because the health probe has no
#      timeout (the occupier accepts the TCP connection but never answers).
#   B. a dead WinINET system proxy -> the backend is healthy but plugin-http sends
#      the localhost health probe through the proxy, so the UI reports a startup
#      failure even though /api/health answers 200.
#   C. a second launch in the same session should be deduplicated (sanity check).
#
# Run it in the interactive desktop session; screenshots use CopyFromScreen.

$ErrorActionPreference = 'Continue'
$share = '\\host.lan\Data'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $share "results\frontend\failures-$stamp"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$log = Join-Path $out 'run.log'
$exe = 'C:\Program Files\HDU Library Sniper\hdu-library-sniper.exe'
$startupLog = "$env:USERPROFILE\.hdu-library-sniper\logs\startup.log"
$guiLogDir = "$env:LOCALAPPDATA\io.github.alaichhe.hdu-library-sniper\logs"
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
function RawHealth {
  # curl.exe does not read WinINET, so this is the proxy-free ground truth.
  $code = & curl.exe --noproxy '*' -s -m 2 -o NUL -w '%{http_code}' 'http://127.0.0.1:8000/api/health'
  return "curl_noproxy_status=$code"
}
function KillApp {
  taskkill /F /IM hdu-library-sniper.exe 2>&1 | Out-Null
  Start-Sleep -Seconds 2
}
function LaunchApp {
  Start-Process -FilePath $exe -PassThru
}
function Wait-Sec([int]$s) { Start-Sleep -Seconds $s }
function Describe([string]$tag) {
  L ("{0}: proc={1} title={2} {3}" -f $tag,
    @(Get-Process -Name hdu-library-sniper -ErrorAction SilentlyContinue).Count,
    (@(Get-Process -Name hdu-library-sniper -ErrorAction SilentlyContinue |
      Where-Object MainWindowTitle | Select-Object -First 1).MainWindowTitle),
    (RawHealth))
  L ("{0}: ui: {1}" -f $tag, (UiaText))
}

L "=== failure-mode probes ==="
L ("user={0} exeExists={1}" -f $env:USERNAME, (Test-Path $exe))
if (-not (Test-Path $exe)) { L 'app not installed; abort'; return }

# ---------------------------------------------------------------- A: port busy
L '--- A: port 8000 occupied by a silent listener ---'
KillApp
Remove-Item $startupLog -Force -ErrorAction SilentlyContinue
$code = '$l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,8000);$l.Start();Start-Sleep -Seconds 240'
$b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
$dummy = Start-Process powershell -ArgumentList '-NoProfile', '-EncodedCommand', $b64 -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
$owner = (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
L ("listener pid={0} owns 8000" -f $owner.OwningProcess)
$appA = LaunchApp
L ("app pid={0}" -f $appA.Id)
$swA = [Diagnostics.Stopwatch]::StartNew()
foreach ($t in 5, 15, 36) {
  while ($swA.Elapsed.TotalSeconds -lt $t) { Start-Sleep -Milliseconds 200 }
  Shot ("A-$t"); Describe ("A t=$t")
}
L ("startup.log A: " + $(if (Test-Path $startupLog) { (Get-Content $startupLog -Raw) } else { '<missing>' }))
KillApp
Stop-Process -Id $dummy.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
L ("port8000 free again: " + (-not [bool](Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue)))

# ------------------------------------------------------------- B: dead proxy
L '--- B: system proxy points at a dead port ---'
Set-ItemProperty $inet -Name ProxyEnable -Value 1 -Type DWord
Set-ItemProperty $inet -Name ProxyServer -Value '127.0.0.1:9'
Set-ItemProperty $inet -Name ProxyOverride -Value '' -Type String
Set-ItemProperty $inet -Name AutoConfigURL -Value '' -Type String -ErrorAction SilentlyContinue
$p = Get-ItemProperty $inet
L ("proxy: Enable={0} Server={1} Override='{2}'" -f $p.ProxyEnable, $p.ProxyServer, $p.ProxyOverride)
KillApp
Remove-Item $startupLog -Force -ErrorAction SilentlyContinue
$appB = LaunchApp
L ("app pid={0}" -f $appB.Id)
$swB = [Diagnostics.Stopwatch]::StartNew()
foreach ($t in 5, 16, 36) {
  while ($swB.Elapsed.TotalSeconds -lt $t) { Start-Sleep -Milliseconds 200 }
  Shot ("B-$t"); Describe ("B t=$t")
}
$gl = @(Get-ChildItem $guiLogDir -Filter *.log -ErrorAction SilentlyContinue)
if ($gl.Count -gt 0) {
  L 'gui log tail:'
  Get-Content $gl[0].FullName -Tail 40 -ErrorAction SilentlyContinue | ForEach-Object { L "  $_" }
}
L ("startup.log B: " + $(if (Test-Path $startupLog) { (Get-Content $startupLog -Raw) } else { '<missing>' }))
KillApp
Set-ItemProperty $inet -Name ProxyEnable -Value 0 -Type DWord
Set-ItemProperty $inet -Name ProxyServer -Value '' -Type String
Set-ItemProperty $inet -Name ProxyOverride -Value '' -Type String
$p = Get-ItemProperty $inet
L ("proxy restored: Enable={0} Server='{1}'" -f $p.ProxyEnable, $p.ProxyServer)

# ------------------------------------------------------ C: single instance
L '--- C: second launch in the same session ---'
KillApp
$app1 = LaunchApp
Start-Sleep -Seconds 6
$n1 = @(Get-Process -Name hdu-library-sniper -ErrorAction SilentlyContinue).Count
$app2 = LaunchApp
Start-Sleep -Seconds 6
$procs = @(Get-Process -Name hdu-library-sniper -ErrorAction SilentlyContinue)
L ("second launch: before={0} after={1} secondExited={2} pids={3}" -f $n1, $procs.Count, $app2.HasExited, (($procs | ForEach-Object { $_.Id }) -join ','))
Describe 'C after second launch'
Shot 'C-second-launch'

# leave a healthy instance running for manual inspection
L ("final: procs={0} {1}" -f @(Get-Process -Name hdu-library-sniper -ErrorAction SilentlyContinue).Count, (RawHealth))
Shot 'Z-final'
L '=== done ==='
