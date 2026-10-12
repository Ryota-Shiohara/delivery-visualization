#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [string]$EnvFile = (Join-Path (Split-Path $PSScriptRoot -Parent) '.env'),
    [string]$Region,
    [string]$Profile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($Profile -and $PSBoundParameters.ContainsKey('EnvFile')) {
    throw 'Use either -Profile or -EnvFile, not both.'
}

$settings = @{}
if (-not $Profile) {
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
        throw 'Deployment .env is missing. Copy the root .env.example to .env and enter the three Lab credentials.'
    }
    $allowedKeys = @('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION')
    $lineNumber = 0
    foreach ($rawLine in [System.IO.File]::ReadAllLines((Resolve-Path -LiteralPath $EnvFile).Path)) {
        $lineNumber++
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        if ($line -notmatch '^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$') {
            throw "Invalid .env format at line $lineNumber. Use KEY=value."
        }
        $key = $Matches[1]
        $value = $Matches[2].Trim()
        if ($key -notin $allowedKeys) {
            throw "Unsupported .env key at line $lineNumber. Only deployment AWS settings are supported."
        }
        if ($settings.ContainsKey($key)) { throw "Duplicate .env key at line $lineNumber." }
        if ($value.StartsWith('"') -or $value.StartsWith("'")) {
            if ($value.Length -lt 2 -or $value[$value.Length - 1] -ne $value[0]) {
                throw "Unclosed .env quote at line $lineNumber."
            }
            $value = $value.Substring(1, $value.Length - 2)
        }
        # 値をコードとして実行せず、変数展開もしない。
        $settings[$key] = $value
    }
    foreach ($key in @('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN')) {
        if (-not $settings.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($settings[$key])) {
            throw "Missing $key in deployment .env."
        }
    }
}
if (-not $Region) {
    $Region = if ($settings.ContainsKey('AWS_REGION') -and $settings.AWS_REGION) { $settings.AWS_REGION } else { 'us-east-1' }
}
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw 'AWS CLI v2 is required.' }

# 認証情報はAWS CLIの実行中だけ環境変数へ設定し、成功・失敗どちらでも復元する。
# npm/Viteには.envの認証情報を渡さない。
$credentialKeys = @('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN')
$previous = @{}
foreach ($key in $credentialKeys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}
$previousFileEncoding = [Environment]::GetEnvironmentVariable('AWS_CLI_FILE_ENCODING', 'Process')
try {
    # リポジトリのYAMLはUTF-8。日本語Windowsのcp932既定値を使わせない。
    [Environment]::SetEnvironmentVariable('AWS_CLI_FILE_ENCODING', 'UTF-8', 'Process')
    foreach ($key in $credentialKeys) {
        $value = if (-not $Profile -and $settings.ContainsKey($key)) { $settings[$key] } else { $null }
        [Environment]::SetEnvironmentVariable($key, $value, 'Process')
    }
    $options = @('--region', $Region, '--no-cli-pager')
    if ($Profile) { $options += @('--profile', $Profile) }
    $output = & aws @Arguments @options
    if ($LASTEXITCODE -ne 0) {
        throw "AWS CLI failed ($LASTEXITCODE). Check Lab credentials and permissions."
    }
    $output
} finally {
    [Environment]::SetEnvironmentVariable('AWS_CLI_FILE_ENCODING', $previousFileEncoding, 'Process')
    foreach ($key in $credentialKeys) {
        [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process')
    }
}
