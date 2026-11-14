<#
  旧 MSI（2.0.x）→ 新 NSIS 安装包的迁移验证。

  Windows 虚拟机和 GitHub Actions 的 windows-latest 都用这一份：
    - 先静默安装一个真实发布过的旧 MSI
    - 写入一份用户数据标记
    - 跑新安装包 setup.exe /S（触发 hooks.nsh 的 NSIS_HOOK_PREINSTALL）
    - 断言旧 MSI 卸载项被清掉、只剩一个条目、用户数据还在、版本正确、自启动指向新路径

  参数：
    -OldMsi     旧 MSI 路径
    -NewSetup   新 NSIS 安装包路径（*-setup.exe）
    -ResultDir  结果输出目录，缺省 $env:TEMP；目录不可写时只打印
#>
param(
  [Parameter(Mandatory = $true)][string]$OldMsi,
  [Parameter(Mandatory = $true)][string]$NewSetup,
  [string]$ResultDir = $env:TEMP
)

$ErrorActionPreference = 'Continue'
$script:failed = 0
$log = [System.Collections.Generic.List[string]]::new()

function Say([string]$message) {
  Write-Host $message
  $log.Add($message)
}

function Fail([string]$message) {
  Say "FAIL  $message"
  $script:failed++
}

function Pass([string]$message) {
  Say "PASS  $message"
}

$installDir = Join-Path $env:ProgramFiles 'HDU Library Sniper'
$appExe = Join-Path $installDir 'hdu-library-sniper.exe'

function Get-Entries {
  foreach ($root in @(
      'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
      'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
    Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
      $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
      if ($props.DisplayName -like '*HDU Library Sniper*') {
        [pscustomobject]@{
          Key     = $_.PSChildName
          Version = $props.DisplayVersion
          Msi     = $props.WindowsInstaller
        }
      }
    }
  }
}

function Format-Entries($entries) {
  if (-not $entries) { return '(none)' }
  ($entries | ForEach-Object { "$($_.Version)[msi=$($_.Msi)]" }) -join ', '
}

Say "== start $(Get-Date -Format o)"

# 1. 清掉当前安装，保证从「只有旧 MSI」的状态开始
if (Test-Path (Join-Path $installDir 'uninstall.exe')) {
  Get-Process hdu-library-sniper -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Start-Process (Join-Path $installDir 'uninstall.exe') '/S' -Wait | Out-Null
  Start-Sleep -Seconds 3
  Say 'cleaned the previous NSIS install'
}

# 2. 安装旧 MSI
$sw = [Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process msiexec.exe -ArgumentList "/i `"$OldMsi`" /qn /norestart" -Wait -PassThru
$sw.Stop()
Say ("old MSI: exit={0} in {1:N1}s" -f $proc.ExitCode, $sw.Elapsed.TotalSeconds)
if ($proc.ExitCode -ne 0) { Fail "old MSI install failed with $($proc.ExitCode)" }
Start-Sleep -Seconds 2

$before = @(Get-Entries)
Say ("entries after old MSI: " + (Format-Entries $before))
if (-not ($before | Where-Object { $_.Msi -eq 1 })) { Fail 'the old MSI did not register an uninstall entry' }

# 3. 用户数据标记
$dataDir = Join-Path $env:USERPROFILE '.hdu-library-sniper\data'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$marker = Join-Path $dataDir 'migration-marker.txt'
Set-Content -Path $marker -Value 'keep-me' -Encoding UTF8
$markerHash = (Get-FileHash $marker -Algorithm SHA256).Hash

# 4. 跑新安装包
$sw = [Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process $NewSetup -ArgumentList '/S' -Wait -PassThru
$sw.Stop()
Say ("new setup: exit={0} in {1:N1}s" -f $proc.ExitCode, $sw.Elapsed.TotalSeconds)
if ($proc.ExitCode -ne 0) { Fail "new setup failed with $($proc.ExitCode)" }
Start-Sleep -Seconds 4

# 5. 断言
$after = @(Get-Entries)
Say ("entries after new setup: " + (Format-Entries $after))

$msiLeft = @($after | Where-Object { $_.Msi -eq 1 })
if ($msiLeft.Count -eq 0) { Pass 'legacy MSI uninstall entry removed' }
else { Fail ("legacy MSI entries left: " + (Format-Entries $msiLeft)) }

if ($after.Count -eq 1) { Pass 'exactly one uninstall entry' }
else { Fail "expected one uninstall entry, found $($after.Count)" }

if (Test-Path $appExe) {
  $version = (Get-Item $appExe).VersionInfo.ProductVersion
  if ($version -like '2.1.*') { Pass "installed exe version $version" }
  else { Fail "unexpected exe version $version" }
} else {
  Fail "exe missing at $appExe"
}

$run = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).'HDU-Library-Sniper'
if ($run -like "*$appExe*--background*") { Pass "autostart = $run" }
else { Fail "autostart missing or stale: $run" }

if ((Test-Path $marker) -and ((Get-FileHash $marker -Algorithm SHA256).Hash -eq $markerHash)) {
  Pass 'user data preserved across the migration'
} else {
  Fail 'user data marker lost'
}

Say "== done, failures=$($script:failed)"

$text = $log -join "`r`n"
try {
  New-Item -ItemType Directory -Force -Path $ResultDir | Out-Null
  $path = Join-Path $ResultDir ('legacy-msi-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
  Set-Content -Path $path -Value $text -Encoding UTF8
  Say "log written to $path"
} catch {
  Say "could not write the log: $_"
}

exit $script:failed
