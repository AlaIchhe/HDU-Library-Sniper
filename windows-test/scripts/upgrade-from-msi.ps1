<#
  2.0.33 MSI  ->  2.1.5 NSIS 的迁移测试。

  这是 NSIS_HOOK_PREINSTALL 里那条最危险的路径（taskkill + msiexec /x{5839189D-…}），
  Linux 上完全测不到。跑之前需要把旧 MSI 放进 oem/ 一起烘进安装介质：

      cp artifacts/HDU.Library.Sniper_2.0.33_x64_zh-CN.msi windows-test/oem/old-2.0.33.msi

  然后在虚拟机里执行（新装镜像上要么等 OEM 脚本跑完，要么手动）：

      powershell -NoProfile -ExecutionPolicy Bypass -File C:\OEM\upgrade-from-msi.ps1

  结果写到 Z:\results\upgrade\<时间戳>\，宿主机的 windows-test/shared/results/upgrade/ 下能看到。
#>
param(
  [string]$OldMsi     = 'C:\OEM\old-2.0.33.msi',
  [string]$NewSetup   = 'C:\OEM\setup.exe',
  [string]$ProductName = 'HDU Library Sniper'
)

$ErrorActionPreference = 'Continue'
$root = if (Test-Path 'Z:\') { 'Z:\results\upgrade' } else { 'C:\OEM\upgrade' }
$out = Join-Path $root (Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Force -Path $out | Out-Null
$log = Join-Path $out 'upgrade.log'
$script:failed = 0

function Log {
  param([string]$Message, [string]$Status = 'INFO')
  $line = "[{0}] {1,-5} {2}" -f (Get-Date -Format 'HH:mm:ss'), $Status, $Message
  Write-Host $line
  Add-Content -Path $log -Value $line
  if ($Status -eq 'FAIL') { $script:failed++ }
}

function Uninstall-Entries {
  foreach ($rootKey in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
                         'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
    Get-ChildItem $rootKey -ErrorAction SilentlyContinue | ForEach-Object {
      $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
      if ($p.DisplayName -like "*$ProductName*") {
        [pscustomobject]@{ Key = $_.PSChildName; Name = $p.DisplayName; Version = $p.DisplayVersion }
      }
    }
  }
}

# 1. 清掉当前安装（如果有），保证从干净的 2.0.33 开始
$installDir = Join-Path $env:ProgramFiles $ProductName
if (Test-Path (Join-Path $installDir 'uninstall.exe')) {
  Get-Process 'hdu-library-sniper' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep 2
  Start-Process (Join-Path $installDir 'uninstall.exe') '/S' -Wait | Out-Null
  Start-Sleep 3
  Log '已卸载当前安装，准备从 2.0.33 MSI 开始'
}

if (-not (Test-Path $OldMsi)) { Log "缺少旧 MSI：$OldMsi" 'FAIL'; exit 1 }

# 2. 装 2.0.33 MSI
$sw = [Diagnostics.Stopwatch]::StartNew()
$msi = Start-Process msiexec.exe -ArgumentList "/i `"$OldMsi`" /qn /norestart" -Wait -PassThru
$sw.Stop()
if ($msi.ExitCode -eq 0) { Log ("2.0.33 MSI 安装完成，{0:N1}s" -f $sw.Elapsed.TotalSeconds) 'PASS' }
else { Log ("2.0.33 MSI 安装失败，exit {0}" -f $msi.ExitCode) 'FAIL' }
Start-Sleep 2

$before = @(Uninstall-Entries)
$before | ForEach-Object { Log ("安装前卸载项：{0} / {1} / {2}" -f $_.Name, $_.Version, $_.Key) }
if (@($before | Where-Object { $_.Version -like '2.0.33*' }).Count -ge 1) { Log '2.0.33 已注册到控制面板' 'PASS' }
else { Log '控制面板里找不到 2.0.33' 'FAIL' }

# 3. 造一份用户数据，验证迁移时不会被清掉
$dataDir = Join-Path $env:USERPROFILE '.hdu-library-sniper\data'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$dbPath = Join-Path $dataDir 'hdu-sniper.sqlite'
Add-Content -Path $dbPath -Value 'migration-marker'
$dbHash = (Get-FileHash $dbPath -Algorithm SHA256).Hash
Log "用户数据标记已写入 $dbPath"

# 4. 直接用 2.1.5 NSIS 覆盖安装，钩子应当先杀掉进程并卸载旧 MSI
$sw = [Diagnostics.Stopwatch]::StartNew()
$setup = Start-Process $NewSetup '/S' -Wait -PassThru
$sw.Stop()
if ($setup.ExitCode -eq 0) { Log ("2.1.5 NSIS 安装完成，{0:N1}s" -f $sw.Elapsed.TotalSeconds) 'PASS' }
else { Log ("2.1.5 NSIS 安装失败，exit {0}" -f $setup.ExitCode) 'FAIL' }
Start-Sleep 3

# 5. 断言
$after = @(Uninstall-Entries)
$after | ForEach-Object { Log ("安装后卸载项：{0} / {1} / {2}" -f $_.Name, $_.Version, $_.Key) }

if ($after.Count -eq 1 -and $after[0].Version -like '2.1.5*') { Log '旧 MSI 卸载项已清理，只剩 2.1.5' 'PASS' }
else { Log ("卸载项状态不对：{0} 条" -f $after.Count) 'FAIL' }

$exe = Join-Path $installDir 'hdu-library-sniper.exe'
if (Test-Path $exe) {
  $vi = (Get-Item $exe).VersionInfo
  Log ("主程序版本 {0}" -f $vi.ProductVersion) $(if ($vi.ProductVersion -like '2.1.5*') { 'PASS' } else { 'FAIL' })
} else { Log "主程序不存在：$exe" 'FAIL' }

$afterHash = if (Test-Path $dbPath) { (Get-FileHash $dbPath -Algorithm SHA256).Hash } else { '' }
if ($afterHash -eq $dbHash) { Log '用户数据在迁移中保留' 'PASS' }
else { Log '用户数据被改动或丢失' 'FAIL' }

$run = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).'HDU-Library-Sniper'
if ($run) { Log "自启动：$run" 'PASS' } else { Log '缺少自启动项' 'FAIL' }

# 6. 启动并检查本地 API
Get-Process 'hdu-library-sniper' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2
Start-Process $exe '--background' | Out-Null
$ok = $false
foreach ($i in 1..30) {
  try { if ((Invoke-WebRequest 'http://127.0.0.1:8000/api/health' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { $ok = $true; break } } catch {}
  Start-Sleep 1
}
if ($ok) { Log '迁移后应用可启动，/api/health 200' 'PASS' } else { Log '迁移后应用健康检查失败' 'FAIL' }

Get-Process 'hdu-library-sniper' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$summary = if ($script:failed -eq 0) { 'ALL PASS' } else { "$($script:failed) FAIL" }
Log "=== 迁移测试结束：$summary ==="
Set-Content -Path (Join-Path $out 'summary.txt') -Value $summary
exit $script:failed
