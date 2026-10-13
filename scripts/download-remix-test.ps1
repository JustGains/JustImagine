$ErrorActionPreference = 'Stop'
$outputDir = Join-Path (Split-Path -Parent $PSScriptRoot) '.artifacts/remix-tests'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$original = Join-Path $outputDir 'hotel-lobby-original.mp4'
$clip = Join-Path $outputDir 'hotel-lobby-50s-58s.mp4'

if (-not (Test-Path -LiteralPath $original)) {
  & yt-dlp --no-playlist -f '136+140/135+140/b[height<=720]' --merge-output-format mp4 -o (Join-Path $outputDir 'hotel-lobby-original.%(ext)s') 'https://www.youtube.com/watch?v=x9yop0nYR9g'
  if ($LASTEXITCODE -ne 0) { throw 'Could not download the official COLORS video.' }
}

& ffmpeg -hide_banner -loglevel error -ss 00:00:50 -i $original -t 8 -vf 'scale=960:-2,fps=24' -c:v libx264 -preset veryfast -crf 22 -c:a aac -b:a 128k -movflags +faststart -y $clip
if ($LASTEXITCODE -ne 0) { throw 'Could not cut the test clip.' }
Write-Output $clip
