<#
  HDU Library Sniper - Windows NSIS installation verification (MyGo v3).

  Runs inside a dockur/windows guest, in the auto-logon user's interactive
  desktop session (see install.bat). Results land in Z:\results\<timestamp>\.
#>
param(
  [switch]$Watch,
  [string]$SetupPath   = 'C:\OEM\setup.exe',
  [string]$Share       = 'Z:\',
  [string]$ProductName = 'HDU Library Sniper',
  [string]$AppId       = 'io.github.alaichhe.hdu-library-sniper',
  [string]$RunArgs     = '--background'
)

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'

if (-not (Test-Path $Share)) {
  try { net use 'Z:' '\\host.lan\Data' /persistent:no 2>&1 | Out-Null } catch {}
}
if (-not (Test-Path $Share)) {
  try { New-Item -ItemType SymbolicLink -Path 'Z:\' -Target '\\host.lan\Data' -ErrorAction Stop | Out-Null } catch {}
}

$script:shareOk = Test-Path $Share
$root = if ($script:shareOk) { 'Z:\results' } else { 'C:\OEM\results' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$script:outDir = Join-Path $root $stamp
New-Item -ItemType Directory -Force -Path $script:outDir | Out-Null
$script:logPath = Join-Path $script:outDir 'verify.log'
$script:checks  = New-Object System.Collections.ArrayList

try { Start-Transcript -Path $script:logPath -Force | Out-Null } catch {}

function Write-Log {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $Message
  Write-Host $line
  Add-Content -Path $script:logPath -Value $line -ErrorAction SilentlyContinue
}

function Add-Check {
  param(
    [string]$Id,
    [ValidateSet('PASS', 'FAIL', 'INFO', 'WARN')][string]$Status,
    [string]$Detail
  )
  Write-Log ("{0,-9} {1}: {2}" -f $Status, $Id, $Detail)
  [void]$script:checks.Add([pscustomobject]@{ id = $Id; status = $Status; detail = $Detail })
}

function Add-Result {
  param([string]$Id, [bool]$Ok, [string]$Pass, [string]$Fail)
  Add-Check -Id $Id -Status ($(if ($Ok) { 'PASS' } else { 'FAIL' })) -Detail ($(if ($Ok) { $Pass } else { $Fail }))
}

function Save-Shot {
  param([string]$Name)
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing -ErrorAction Stop
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $path = Join-Path $script:outDir "$Name.png"
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $gfx.Dispose(); $bmp.Dispose()
    Write-Log "screenshot $Name ($($bounds.Width)x$($bounds.Height))"
  } catch {
    Write-Log "screenshot $Name failed: $_"
  }
}

function Wait-Until {
  param([scriptblock]$Condition, [int]$TimeoutSec, [int]$IntervalMs = 500)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try { if (& $Condition) { return $true } } catch {}
    Start-Sleep -Milliseconds $IntervalMs
  }
  return $false
}

function Test-Desktop {
  [bool](Get-Process -Name explorer -ErrorAction SilentlyContinue)
}

$UninstallRoots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
)

function Get-UninstallEntry {
  foreach ($root in $UninstallRoots) {
    Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
      $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
      if ($_.PSChildName -eq $AppId -or ($props.DisplayName -and $props.DisplayName -like "*$ProductName*")) {
        [pscustomobject]@{
          Key             = $_.PSChildName
          Root            = $root
          DisplayName     = $props.DisplayName
          DisplayVersion  = $props.DisplayVersion
          InstallLocation = ($props.InstallLocation -replace '"', '')
          UninstallString = $props.UninstallString
          Publisher       = $props.Publisher
        }
      }
    }
  }
}

function Get-RunEntry {
  (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).$AppId
}

function Invoke-Suite {
  $started = Get-Date
  Write-Log '=== HDU Library Sniper Windows install verification (MyGo v3) ==='
  Write-Log ("host: user={0} elevated={1} share={2}" -f $env:USERNAME, ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator), $script:shareOk)

  $os = Get-CimInstance Win32_OperatingSystem
  $cs = Get-CimInstance Win32_ComputerSystem
  $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  Add-Check -Id 'env.os' -Status 'INFO' -Detail ("{0} {1} (build {2})" -f $os.Caption, $cv.DisplayVersion, $cv.CurrentBuild)
  Add-Check -Id 'env.hardware' -Status 'INFO' -Detail ("{0} vCPU, {1:N1} GB RAM, {2}" -f $cs.NumberOfLogicalProcessors, ($cs.TotalPhysicalMemory / 1GB), $cs.Manufacturer)

  $webview2 = Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue
  Add-Check -Id 'env.webview2' -Status ($(if ($webview2) { 'INFO' } else { 'WARN' })) -Detail ("WebView2 runtime {0}" -f ($(if ($webview2) { $webview2.pv } else { 'NOT INSTALLED' })))

  $processName = $ProductName
  $installDir  = Join-Path $env:LOCALAPPDATA "Programs\$ProductName"
  $appExe      = Join-Path $installDir "$ProductName.exe"
  $uninstaller = Join-Path $installDir 'Uninstall.exe'
  $dataDir     = Join-Path $env:APPDATA $ProductName
  $dbPath      = Join-Path $dataDir 'data\sniper.db'
  $startLnk    = Join-Path ([Environment]::GetFolderPath('Programs')) "$ProductName.lnk"

  # -- 1. clean baseline ----------------------------------------------------
  $preEntry = Get-UninstallEntry
  $preDir   = Test-Path $installDir
  if ($preEntry -or $preDir) {
    if (Test-Path $uninstaller) {
      Get-Process -Name $processName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
      Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait | Out-Null
      [void](Wait-Until { -not (Test-Path $appExe) } 90)
    }
    Add-Check -Id 'baseline.cleanup' -Status 'INFO' -Detail 'removed the installation left by the previous run'
    Start-Sleep -Seconds 2
  }
  Add-Result -Id 'baseline.clean' -Ok (-not (Get-UninstallEntry) -and -not (Test-Path $installDir)) `
    -Pass 'no previous installation present' `
    -Fail ("previous install still present: dir={0} entry={1}" -f (Test-Path $installDir), ((Get-UninstallEntry) | ConvertTo-Json -Compress))

  if (Test-Path $dataDir) { Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue }
  Save-Shot 'pre-install'

  # -- 2. silent install ----------------------------------------------------
  if (-not (Test-Path $SetupPath)) {
    Add-Check -Id 'install.exec' -Status 'FAIL' -Detail "installer not found at $SetupPath"
    return
  }
  Write-Log ("installer: {0} ({1:N0} bytes)" -f $SetupPath, (Get-Item $SetupPath).Length)

  $sw = [Diagnostics.Stopwatch]::StartNew()
  $proc = Start-Process -FilePath $SetupPath -ArgumentList '/S' -Wait -PassThru
  $sw.Stop()
  $installSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  Add-Result -Id 'install.exit' -Ok ($proc.ExitCode -eq 0) `
    -Pass ("silent install finished in {0}s (exit 0)" -f $installSeconds) `
    -Fail ("silent install exit code {0} after {1}s" -f $proc.ExitCode, $installSeconds)
  Start-Sleep -Seconds 2

  # -- 3. files & shortcut -------------------------------------------------
  Add-Result -Id 'files.exe' -Ok (Test-Path $appExe) `
    -Pass ("installed {0}" -f $appExe) `
    -Fail ("missing {0}" -f $appExe)

  if (Test-Path $appExe) {
    $vi = (Get-Item $appExe).VersionInfo
    Add-Check -Id 'files.version' -Status 'INFO' -Detail ("FileVersion={0} ProductVersion={1} size={2:N0} bytes" -f $vi.FileVersion, $vi.ProductVersion, (Get-Item $appExe).Length)
  }
  Add-Result -Id 'files.uninstaller' -Ok (Test-Path $uninstaller) `
    -Pass 'Uninstall.exe present' -Fail 'Uninstall.exe missing'
  Add-Result -Id 'shortcut.startmenu' -Ok (Test-Path $startLnk) `
    -Pass ("start menu shortcut {0}" -f $startLnk) `
    -Fail ("missing start menu shortcut {0}" -f $startLnk)

  # -- 4. registry ---------------------------------------------------------
  $entry = Get-UninstallEntry
  Add-Result -Id 'registry.uninstall' -Ok ([bool]$entry) `
    -Pass ("DisplayName='{0}' version={1} location={2}" -f $entry.DisplayName, $entry.DisplayVersion, $entry.InstallLocation) `
    -Fail 'no Add/Remove Programs entry found'
  if ($entry -and $entry.InstallLocation) {
    Add-Result -Id 'registry.installlocation' -Ok ($entry.InstallLocation -ieq $installDir) `
      -Pass "InstallLocation matches $installDir" `
      -Fail ("InstallLocation is '{0}', expected '{1}'" -f $entry.InstallLocation, $installDir)
  }

  # -- 5. launch & first-run initialization --------------------------------
  $existing = Get-Process -Name $processName -ErrorAction SilentlyContinue
  if ($existing) { $existing | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }

  $launch = Start-Process -FilePath $appExe -ArgumentList $RunArgs -PassThru
  Write-Log ("launched pid {0}" -f $launch.Id)
  $alive = Wait-Until { -not (Get-Process -Id $launch.Id -ErrorAction SilentlyContinue).HasExited } 20
  Add-Result -Id 'launch.survives' -Ok $alive `
    -Pass 'process still running after 20s' `
    -Fail 'process exited within 20s'

  $dbReady = Wait-Until { Test-Path $dbPath } 30
  Add-Result -Id 'data.sqlite' -Ok $dbReady `
    -Pass ("database created at {0}" -f $dbPath) `
    -Fail ("no sqlite database at {0}" -f $dbPath)

  $run = Get-RunEntry
  $expectedRun = '"{0}" --mygo-opened-at-login' -f $appExe
  Add-Result -Id 'registry.autostart' -Ok ($run -eq $expectedRun) `
    -Pass ("HKCU Run = {0}" -f $run) `
    -Fail ("HKCU Run is '{0}', expected '{1}'" -f $run, $expectedRun)

  Start-Sleep -Seconds 2
  Save-Shot 'running-background'

  # -- 6. single instance --------------------------------------------------
  $second = Start-Process -FilePath $appExe -PassThru
  Start-Sleep -Seconds 6
  $count = @(Get-Process -Name $processName -ErrorAction SilentlyContinue).Count
  $secondAlive = -not (Get-Process -Id $second.Id -ErrorAction SilentlyContinue).HasExited
  Add-Result -Id 'single-instance' -Ok ($count -eq 1) `
    -Pass 'second launch did not spawn a second process' `
    -Fail ("{0} instance(s) running after second launch (second alive={1})" -f $count, $secondAlive)
  Save-Shot 'second-launch'

  # -- 7. data survives overwrite install ----------------------------------
  Get-Process -Name $processName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  $before = if (Test-Path $dbPath) { (Get-FileHash $dbPath -Algorithm SHA256).Hash } else { '' }

  $over = Start-Process -FilePath $SetupPath -ArgumentList '/S' -Wait -PassThru
  Start-Sleep -Seconds 2
  $after = if (Test-Path $dbPath) { (Get-FileHash $dbPath -Algorithm SHA256).Hash } else { '' }
  Add-Result -Id 'reinstall.data' -Ok ([bool]$before -and $before -eq $after) `
    -Pass ("user data untouched by reinstall (sha256 {0})" -f $before.Substring(0, 12)) `
    -Fail ("data changed or missing across reinstall: before={0} after={1} exit={2}" -f $before, $after, $over.ExitCode)

  $entry2 = Get-UninstallEntry
  Add-Result -Id 'reinstall.no-duplicate' -Ok (@($entry2).Count -eq 1) `
    -Pass 'still a single Add/Remove Programs entry' `
    -Fail ("{0} Add/Remove Programs entries after reinstall" -f @($entry2).Count)

  # -- 8. uninstall --------------------------------------------------------
  if (Test-Path $uninstaller) {
    $un = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
    Write-Log ("uninstaller exit {0}" -f $un.ExitCode)
    $gone = Wait-Until { -not (Test-Path $appExe) } 90
    Add-Result -Id 'uninstall.files' -Ok $gone `
      -Pass 'application files removed' `
      -Fail ("app still present after uninstall; leftover: {0}" -f ((Get-ChildItem $installDir -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ', '))
  } else {
    Add-Check -Id 'uninstall.files' -Status 'FAIL' -Detail 'no uninstaller to run'
  }

  Start-Sleep -Seconds 2
  Add-Result -Id 'uninstall.registry' -Ok (-not (Get-UninstallEntry)) `
    -Pass 'Add/Remove Programs entry removed' `
    -Fail 'Add/Remove Programs entry survived uninstall'
  Add-Result -Id 'uninstall.autostart' -Ok (-not (Get-RunEntry)) `
    -Pass 'HKCU Run entry removed' `
    -Fail ("HKCU Run entry survived: {0}" -f (Get-RunEntry))
  Add-Check -Id 'shortcut.removed' -Status ($(if (Test-Path $startLnk) { 'WARN' } else { 'PASS' })) `
    -Detail ($(if (Test-Path $startLnk) { "shortcut left behind: $startLnk" } else { 'start menu shortcut removed' }))

  $left = @(Get-Process -Name $processName -ErrorAction SilentlyContinue).Count
  Add-Check -Id 'uninstall.processes' -Status ($(if ($left -eq 0) { 'PASS' } else { 'WARN' })) -Detail ("{0} app process(es) left running" -f $left)

  $dataKept = Test-Path $dataDir
  Add-Check -Id 'uninstall.userdata' -Status 'INFO' -Detail ("user data dir {0}" -f ($(if ($dataKept) { 'preserved (expected: credentials survive)' } else { 'removed' })))

  Save-Shot 'after-uninstall'

  # -- 9. report -----------------------------------------------------------
  $finished = Get-Date
  $fail = @($script:checks | Where-Object status -eq 'FAIL').Count
  $pass = @($script:checks | Where-Object status -eq 'PASS').Count
  $report = [ordered]@{
    product    = $ProductName
    startedAt  = $started.ToString('o')
    finishedAt = $finished.ToString('o')
    durationS  = [math]::Round(($finished - $started).TotalSeconds, 1)
    share      = $script:shareOk
    summary    = [ordered]@{ pass = $pass; fail = $fail; total = $script:checks.Count }
    checks     = @($script:checks)
  }
  $reportPath = Join-Path $script:outDir 'report.json'
  $report | ConvertTo-Json -Depth 6 | Set-Content -Path $reportPath -Encoding UTF8
  Write-Log ("=== done: {0} passed, {1} failed -> {2} ===" -f $pass, $fail, $reportPath)

  if (-not $script:shareOk) {
    Copy-Item -Recurse -Force $script:outDir 'C:\OEM\last-run' -ErrorAction SilentlyContinue
  }
}

function Invoke-Jobs {
  $jobs = 'Z:\jobs'
  if (-not (Test-Path $jobs)) { return }
  try { New-Item -ItemType File -Force -Path (Join-Path $jobs '.tick') | Out-Null } catch {}
  Get-ChildItem $jobs -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.ps1', '.cmd', '.bat' } | ForEach-Object {
    $job = $_
    $outDir = 'Z:\results\jobs'
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    $out = Join-Path $outDir ($job.BaseName + '.out')
    Write-Log ("job start: {0}" -f $job.Name)
    try {
      if ($job.Extension -eq '.ps1') {
        $text = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $job.FullName 2>&1
      } else {
        $text = & cmd.exe /d /c "`"$($job.FullName)`"" 2>&1
      }
      $text | Out-File -FilePath $out -Encoding UTF8 -Append
      Add-Content -Path $out -Value "[done] exit=$LASTEXITCODE"
    } catch {
      Add-Content -Path $out -Value "[error] $_"
    }
    Move-Item -Force $job.FullName (Join-Path $outDir ($job.Name + '.done')) -ErrorAction SilentlyContinue
    Write-Log ("job done: {0}" -f $job.Name)
  }
}

if (-not (Wait-Until { Test-Desktop } 300 1000)) {
  Write-Log 'explorer desktop never appeared; continuing anyway'
}
Start-Sleep -Seconds 5

try { Invoke-Suite } catch { Write-Log ("suite crashed: {0}" -f ($_ | Out-String)) }

if ($Watch) {
  Write-Log 'watch mode: polling Z:\jobs every 3s'
  while ($true) {
    try { Invoke-Jobs } catch { Write-Log ("job poll failed: {0}" -f $_) }
    Start-Sleep -Seconds 3
  }
}
