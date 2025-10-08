$url = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js'
$dest = Join-Path $PSScriptRoot 'libs\supabase.min.js'
if (!(Test-Path (Split-Path $dest))) { New-Item -ItemType Directory -Path (Split-Path $dest) | Out-Null }
try {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -ErrorAction Stop
    Write-Host "Downloaded supabase SDK to $dest"
} catch {
    Write-Error "Failed to download supabase SDK: $_"
}
