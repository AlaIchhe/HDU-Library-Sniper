param(
    [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent -Path $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent -Path $ScriptDir
if (-not $OutputDir) {
    $OutputDir = Join-Path $Root "assets"
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

Add-Type -AssemblyName System.Drawing
$size = 1024
$bitmap = [System.Drawing.Bitmap]::new($size, $size)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(16, 78, 61))

$gold = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(245, 184, 65))
$white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(247, 250, 248))
$coral = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(234, 92, 80), 38)
$coral.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$coral.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

try {
    $roof = [System.Drawing.Point[]]@(
        [System.Drawing.Point]::new(180, 380),
        [System.Drawing.Point]::new(512, 185),
        [System.Drawing.Point]::new(844, 380)
    )
    $graphics.FillPolygon($gold, $roof)
    $graphics.FillRectangle($white, 220, 390, 584, 66)
    foreach ($x in @(260, 400, 540, 680)) {
        $graphics.FillRectangle($white, $x, 455, 84, 270)
    }
    $graphics.FillRectangle($gold, 190, 725, 644, 76)

    $graphics.DrawEllipse($coral, 600, 570, 245, 245)
    $graphics.DrawLine($coral, 722, 530, 722, 855)
    $graphics.DrawLine($coral, 560, 692, 885, 692)

    $pngPath = Join-Path $OutputDir "app-icon.png"
    $bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $images = @()
    foreach ($iconSize in @(16, 24, 32, 48, 64, 128, 256)) {
        $scaled = [System.Drawing.Bitmap]::new($iconSize, $iconSize)
        $scaledGraphics = [System.Drawing.Graphics]::FromImage($scaled)
        try {
            $scaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $scaledGraphics.DrawImage($bitmap, 0, 0, $iconSize, $iconSize)
            $stream = [System.IO.MemoryStream]::new()
            $scaled.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
            $images += ,@($iconSize, $stream.ToArray())
            $stream.Dispose()
        } finally {
            $scaledGraphics.Dispose()
            $scaled.Dispose()
        }
    }

    $icoPath = Join-Path $OutputDir "app-icon.ico"
    $file = [System.IO.File]::Create($icoPath)
    $writer = [System.IO.BinaryWriter]::new($file)
    try {
        $writer.Write([uint16]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]$images.Count)
        $offset = 6 + (16 * $images.Count)
        foreach ($image in $images) {
            $dimension = if ($image[0] -eq 256) { 0 } else { $image[0] }
            $writer.Write([byte]$dimension)
            $writer.Write([byte]$dimension)
            $writer.Write([byte]0)
            $writer.Write([byte]0)
            $writer.Write([uint16]1)
            $writer.Write([uint16]32)
            $writer.Write([uint32]$image[1].Length)
            $writer.Write([uint32]$offset)
            $offset += $image[1].Length
        }
        foreach ($image in $images) {
            $writer.Write([byte[]]$image[1])
        }
    } finally {
        $writer.Dispose()
        $file.Dispose()
    }
} finally {
    $coral.Dispose()
    $gold.Dispose()
    $white.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}

Write-Output "Generated $pngPath and $icoPath"
