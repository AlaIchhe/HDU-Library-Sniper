<#
.SYNOPSIS
    Bumps the project version in pyproject.toml, src/hdu_sniper/__init__.py and uv.lock.

.DESCRIPTION
    Keeps every version source in sync and optionally commits, tags and pushes
    the change. Run this before creating a GitHub release so the v* tag always
    matches the version embedded in the code.

.EXAMPLE
    .\scripts\bump-version.ps1 1.4.0 -DryRun

.EXAMPLE
    .\scripts\bump-version.ps1 1.4.0 -Commit -Tag -Push

.EXAMPLE
    .\scripts\bump-version.ps1 1.4.0 -Commit -Tag -Push -NotesFile RELEASE_NOTES.md

.EXAMPLE
    .\scripts\bump-version.ps1 1.4.0 -Commit -Tag -Push -NotesFile RELEASE_NOTES.md -Title "v1.4.0 - Auto check-in"

.EXAMPLE
    .\scripts\bump-version.ps1 1.4.0 -Commit -Tag -Push -NotesFile RELEASE_NOTES.md -DeleteNotesFile
#>
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+(?:[-.+A-Za-z][0-9A-Za-z.-]*)?$')]
    [string]$Version,

    [switch]$Commit,
    [switch]$Tag,
    [switch]$Push,
    [switch]$SkipLock,
    [string]$Notes,
    [string]$NotesFile,
    [string]$Title,
    [switch]$DeleteNotesFile,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent -Path $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent -Path $ScriptDir
$PyProject = Join-Path $Root "pyproject.toml"
$InitFile = Join-Path $Root "src\hdu_sniper\__init__.py"
$TagName = "v$Version"

if (-not (Test-Path -LiteralPath $PyProject -PathType Leaf)) {
    throw "pyproject.toml not found: $PyProject"
}
if (-not (Test-Path -LiteralPath $InitFile -PathType Leaf)) {
    throw "Package __init__.py not found: $InitFile"
}

function Read-Utf8 {
    param([string]$Path)
    $encoding = New-Object System.Text.UTF8Encoding($false)
    return [System.IO.File]::ReadAllText($Path, $encoding)
}

function Write-Utf8 {
    param([string]$Path, [string]$Content)
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Get-CurrentVersion {
    param([string]$Path, [string]$Pattern)
    $match = [regex]::Match((Read-Utf8 -Path $Path), $Pattern)
    if (-not $match.Success) {
        throw "Cannot find a version in $Path"
    }
    return $match.Groups[1].Value
}

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

if ($Notes -and $NotesFile) {
    throw "Specify only one of -Notes or -NotesFile."
}
if ($DeleteNotesFile -and -not $NotesFile) {
    throw "-DeleteNotesFile requires -NotesFile."
}
$notesText = ""
if ($NotesFile) {
    if (-not (Test-Path -LiteralPath $NotesFile -PathType Leaf)) {
        throw "Notes file not found: $NotesFile"
    }
    $notesText = (Read-Utf8 -Path $NotesFile).TrimEnd("`r", "`n")
} elseif ($Notes) {
    $notesText = $Notes.TrimEnd("`r", "`n")
}
$tagSubject = $TagName
if ($Title) {
    if ($Title -match "[`r`n]") {
        throw "Title must be a single line."
    }
    $tagSubject = $Title
}
$tagMessage = $tagSubject
if ($notesText) {
    $tagMessage += "`n`n" + $notesText
}

$currentVersion = Get-CurrentVersion -Path $PyProject -Pattern '(?m)^version = "([^"]+)"'
$filesChanged = $false

if ($currentVersion -eq $Version) {
    Write-Host "Project version is already $Version; nothing to update."
} else {
    $targets = @(
        @{ Path = $PyProject; Pattern = '(?m)^version = "[^"]*"'; Replacement = "version = `"$Version`"" },
        @{ Path = $InitFile; Pattern = '(?m)^__version__ = "[^"]*"'; Replacement = "__version__ = `"$Version`"" }
    )

    foreach ($target in $targets) {
        $content = Read-Utf8 -Path $target.Path
        $versionMatches = [regex]::Matches($content, $target.Pattern)
        if ($versionMatches.Count -ne 1) {
            throw "Expected exactly one version line in $($target.Path), found $($versionMatches.Count)."
        }
        $oldLine = $versionMatches[0].Value
        $newContent = $content -replace $target.Pattern, $target.Replacement
        if ($DryRun) {
            Write-Host "[DRY-RUN] $($target.Path): $oldLine -> $($target.Replacement)"
        } else {
            Write-Utf8 -Path $target.Path -Content $newContent
            Write-Host "Updated $($target.Path)"
        }
    }

    if (-not $DryRun) {
        $newProjectVersion = Get-CurrentVersion -Path $PyProject -Pattern '(?m)^version = "([^"]+)"'
        $newPackageVersion = Get-CurrentVersion -Path $InitFile -Pattern '(?m)^__version__ = "([^"]+)"'
        if ($newProjectVersion -ne $Version -or $newPackageVersion -ne $Version) {
            throw "Verification failed: pyproject.toml=$newProjectVersion, __init__.py=$newPackageVersion"
        }
    }

    if ($SkipLock) {
        Write-Host "Skipping uv.lock update (-SkipLock)."
    } elseif ($DryRun) {
        Write-Host "[DRY-RUN] Would run: uv lock"
    } else {
        Write-Host "Updating uv.lock..."
        Invoke-Checked "uv" @("lock")
    }
    $filesChanged = $true
}

if ($Tag -and -not $Commit) {
    Write-Host "Note: -Tag implies -Commit."
    $Commit = $true
}

if ($DryRun) {
    if ($filesChanged) {
        if ($Commit) { Write-Host "[DRY-RUN] Would commit: chore: bump version to $Version" }
        if ($Tag) {
            Write-Host "[DRY-RUN] Would create tag: $TagName"
            Write-Host "[DRY-RUN] Release title: $tagSubject"
            if ($notesText) {
                Write-Host "[DRY-RUN] Tag message body:"
                $notesText -split "`n" | ForEach-Object { Write-Host "  $_" }
            }
        }
        if ($Push) { Write-Host "[DRY-RUN] Would push branch and tag" }
        if ($DeleteNotesFile) { Write-Host "[DRY-RUN] Would delete notes file: $NotesFile" }
    } elseif ($Tag) {
        Write-Host "[DRY-RUN] Would create tag: $TagName"
        Write-Host "[DRY-RUN] Release title: $tagSubject"
        if ($notesText) {
            Write-Host "[DRY-RUN] Tag message body:"
            $notesText -split "`n" | ForEach-Object { Write-Host "  $_" }
        }
        if ($Push) { Write-Host "[DRY-RUN] Would push tag" }
        if ($DeleteNotesFile) { Write-Host "[DRY-RUN] Would delete notes file: $NotesFile" }
    }
    exit 0
}

if ($Commit -or $Tag -or $Push) {
    Invoke-Checked "git" @("rev-parse", "--is-inside-work-tree") | Out-Null
}

if ($Commit -and $filesChanged) {
    Invoke-Checked "git" @("add", "--", "pyproject.toml", "src/hdu_sniper/__init__.py", "uv.lock")
    Invoke-Checked "git" @("commit", "-m", "chore: bump version to $Version")
} elseif ($Commit) {
    Write-Host "No version changes to commit."
}

if ($Tag) {
    $null = & git rev-parse -q --verify "refs/tags/$TagName" 2>$null
    if ($LASTEXITCODE -eq 0) {
        throw "Tag $TagName already exists."
    }
    Invoke-Checked "git" @("tag", "-a", $TagName, "-m", $tagMessage)
}

if ($Push) {
    if ($Tag) {
        Invoke-Checked "git" @("push", "--follow-tags")
    } else {
        Invoke-Checked "git" @("push")
    }
}

if ($DeleteNotesFile -and (Test-Path -LiteralPath $NotesFile -PathType Leaf)) {
    $null = & git ls-files --error-unmatch -- $NotesFile 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Warning "Notes file is tracked by git; skipping deletion: $NotesFile"
    } else {
        Remove-Item -LiteralPath $NotesFile -Force
        Write-Host "Removed notes file: $NotesFile"
    }
}

Write-Host ""
Write-Host "Version bumped to $Version."
Write-Host "Push the v* tag to trigger .github/workflows/desktop-release.yml."
