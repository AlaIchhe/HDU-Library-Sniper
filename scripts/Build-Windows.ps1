param(
    [switch]$SkipBrowserDownload,
    [switch]$SkipInstaller,
    [string]$CertificateSha1 = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent -Path $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent -Path $ScriptDir
$Version = (Select-String -Path (Join-Path $Root "pyproject.toml") -Pattern '^version = "(.+)"$').Matches.Groups[1].Value
$BrowserDir = Join-Path $Root "packaging\.cache\playwright-browsers"
$FontDir = Join-Path $Root "assets\fonts"
$DesktopDir = Join-Path $Root "build\desktop"
$AppDir = Join-Path $DesktopDir "HDU-Library-Sniper"
$DistDir = Join-Path $Root "dist"

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

function Test-BundledChromium {
    $env:PLAYWRIGHT_BROWSERS_PATH = $BrowserDir
    & uv run python -c "from playwright.sync_api import sync_playwright; p = sync_playwright().start(); b = p.chromium.launch(headless=True); b.close(); p.stop()"
    return $LASTEXITCODE -eq 0
}

function Copy-InstalledChromium {
    $cache = Join-Path $env:LOCALAPPDATA "ms-playwright"
    if (-not (Test-Path -LiteralPath $cache -PathType Container)) {
        return $false
    }
    New-Item -ItemType Directory -Path $BrowserDir -Force | Out-Null
    $headlessShell = Get-ChildItem -LiteralPath $cache -Directory -Filter "chromium_headless_shell-*" |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if (-not $headlessShell) {
        return $false
    }
    Copy-Item -LiteralPath $headlessShell.FullName -Destination $BrowserDir -Recurse
    $ffmpeg = Get-ChildItem -LiteralPath $cache -Directory -Filter "ffmpeg-*" |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if ($ffmpeg) {
        Copy-Item -LiteralPath $ffmpeg.FullName -Destination $BrowserDir -Recurse
    }
    return (Test-BundledChromium)
}

Set-Location -Path $Root
New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
Invoke-Checked "uv" @("sync", "--group", "package")
& (Join-Path $ScriptDir "Generate-AppIcons.ps1")

if (Test-Path -LiteralPath $DesktopDir) {
    Remove-Item -LiteralPath $DesktopDir -Recurse -Force
}
if (-not $SkipBrowserDownload) {
    if (Test-Path -LiteralPath $BrowserDir) {
        Remove-Item -LiteralPath $BrowserDir -Recurse -Force
    }
    if (-not (Copy-InstalledChromium)) {
        if (Test-Path -LiteralPath $BrowserDir) {
            Remove-Item -LiteralPath $BrowserDir -Recurse -Force
        }
        $env:PLAYWRIGHT_BROWSERS_PATH = $BrowserDir
        Invoke-Checked "uv" @("run", "playwright", "install", "chromium", "--only-shell")
    }
}
if (-not (Test-Path -LiteralPath $BrowserDir -PathType Container)) {
    throw "Bundled Chromium not found at $BrowserDir. Run without -SkipBrowserDownload."
}

$packArgs = @(
    "run", "flet", "pack", "src\desktop.py",
    "--onedir",
    "--distpath", $DesktopDir,
    "--name", "HDU-Library-Sniper",
    "--icon", "assets\app-icon.ico",
    "--product-name", "HDU Library Sniper",
    "--file-description", "HDU Library seat booking desktop application",
    "--product-version", $Version,
    "--file-version", "$Version.0",
    "--company-name", "HDU Library Sniper Contributors",
    "--copyright", "Copyright (C) 2026 HDU Library Sniper Contributors",
    "--add-data", "${BrowserDir}:playwright-browsers",
    "--add-data", "${FontDir}:assets/fonts",
    "--add-data", "scripts\AutoSchedule.ps1:scripts",
    "--hidden-import", "playwright.sync_api",
    "--yes"
)
Invoke-Checked "uv" $packArgs
$generatedSpec = Join-Path $Root "HDU-Library-Sniper.spec"
if (Test-Path -LiteralPath $generatedSpec) {
    Remove-Item -LiteralPath $generatedSpec -Force
}

if (-not (Test-Path -LiteralPath (Join-Path $AppDir "HDU-Library-Sniper.exe"))) {
    throw "Packaged executable was not created: $AppDir"
}
$Executable = Join-Path $AppDir "HDU-Library-Sniper.exe"
$selfCheck = Start-Process -FilePath $Executable -ArgumentList "--self-check" -WindowStyle Hidden -Wait -PassThru
if ($selfCheck.ExitCode -ne 0) {
    throw "Packaged application self-check failed with exit code $($selfCheck.ExitCode)."
}

if ($CertificateSha1) {
    $signTool = (Get-Command "signtool.exe" -ErrorAction SilentlyContinue).Source
    if (-not $signTool) {
        throw "CertificateSha1 was provided but signtool.exe was not found."
    }
    Invoke-Checked $signTool @(
        "sign", "/sha1", $CertificateSha1, "/fd", "sha256",
        "/tr", "http://timestamp.digicert.com", "/td", "sha256",
        $Executable
    )
}

$portableZip = Join-Path $DistDir "HDU-Library-Sniper-$Version-windows-x64-portable.zip"
if (Test-Path -LiteralPath $portableZip) {
    Remove-Item -LiteralPath $portableZip -Force
}
$archiveCreated = $false
for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
        Compress-Archive -Path (Join-Path $AppDir "*") -DestinationPath $portableZip -CompressionLevel Optimal
        $archiveCreated = $true
        break
    } catch {
        if ($attempt -eq 5) {
            throw
        }
        Start-Sleep -Seconds 2
    }
}
if (-not $archiveCreated) {
    throw "Portable archive was not created: $portableZip"
}

if (-not $SkipInstaller) {
    $isccCandidates = @(
        (Get-Command "ISCC.exe" -ErrorAction SilentlyContinue).Source,
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        (Join-Path $Root "packaging\.cache\tools\Inno Setup 6\ISCC.exe")
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
    $iscc = $isccCandidates | Select-Object -First 1
    if (-not $iscc) {
        throw "Inno Setup 6 was not found. Portable app created at $portableZip. Install Inno Setup or use -SkipInstaller."
    }
    Invoke-Checked $iscc @(
        "/DAppVersion=$Version",
        "/DSourceDir=$AppDir",
        "/DOutputDir=$DistDir",
        (Join-Path $Root "packaging\windows\installer.iss")
    )
    $installer = Join-Path $DistDir "HDU-Library-Sniper-Setup-$Version.exe"
    if ($CertificateSha1) {
        Invoke-Checked $signTool @(
            "sign", "/sha1", $CertificateSha1, "/fd", "sha256",
            "/tr", "http://timestamp.digicert.com", "/td", "sha256", $installer
        )
    }
    Write-Output "Installer: $installer"
}

Write-Output "Desktop app: $AppDir"
Write-Output "Portable archive: $portableZip"
