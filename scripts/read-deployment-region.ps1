#Requires -Version 5.1
param([string]$EnvFile = (Join-Path (Split-Path $PSScriptRoot -Parent) '.env'))
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw 'Deployment .env is missing.' }
# 認証情報を返さずリージョンだけを読む。全体の検証はaws-with-envが担当する。
$regions = @([IO.File]::ReadAllLines((Resolve-Path -LiteralPath $EnvFile).Path) | Where-Object { $_ -match '^\s*(?:export\s+)?AWS_REGION\s*=' })
if ($regions.Count -gt 1) { throw 'Duplicate AWS_REGION in deployment .env.' }
$region = 'us-east-1'
if ($regions.Count) {
    $value = ($regions[0] -replace '^\s*(?:export\s+)?AWS_REGION\s*=\s*', '').Trim().Trim('"', "'")
    if ($value) { $region = $value }
}
if ($region -notmatch '^[a-z]{2}(?:-[a-z]+)+-\d+$') { throw 'Invalid AWS_REGION.' }
$region
