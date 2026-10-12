#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$')]
    [string]$BucketName,

    [ValidatePattern('^[A-Z0-9]+$')]
    [string]$DistributionId,

    [string]$Profile,
    [string]$EnvFile,
    [string]$Region,
    [ValidatePattern('^\d{12}$')]
    [string]$ExpectedAccountId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$collectorPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'apps/collector'
$distPath = Join-Path $collectorPath 'dist'
$destination = if ($DistributionId) { "s3://$BucketName/" } else { "s3://$BucketName/site/" }

# WhatIf はローカルビルドも AWS 通信も行わず、実行内容だけを表示する。
if ($WhatIfPreference) {
    Write-Host "Preview: npm ci -> npm test -> npm run build ($collectorPath)"
    Write-Host "Preview: check AWS identity and bucket ($BucketName)"
    Write-Host "Preview: upload assets first, then index.html to $destination (no deletion)"
    if ($DistributionId) {
        Write-Host "Preview: check CloudFront origin, invalidate /* on $DistributionId and wait"
    } else {
        Write-Host 'Preview: S3-only HTTPS hosting at /site/index.html (no CloudFront calls)'
    }
    return
}

foreach ($command in @('aws', 'npm')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "$command is required. Install AWS CLI v2 and a supported Node.js version."
    }
}

$awsWrapper = Join-Path $PSScriptRoot 'aws-with-env.ps1'
$awsOptions = @{}
if ($EnvFile) { $awsOptions.EnvFile = $EnvFile }
if ($Profile) { $awsOptions.Profile = $Profile }
if ($Region) { $awsOptions.Region = $Region }

function Invoke-Aws {
    param([string[]]$Arguments)
    & $awsWrapper -Arguments $Arguments @awsOptions
}

function Invoke-Npm {
    param([string[]]$Arguments)
    & npm @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($Arguments -join ' ') failed ($LASTEXITCODE). Deployment stopped."
    }
}

$identity = (Invoke-Aws -Arguments @('sts', 'get-caller-identity', '--output', 'json')) -join "`n" | ConvertFrom-Json
if ($ExpectedAccountId -and $identity.Account -ne $ExpectedAccountId) {
    throw "AWS account mismatch. Expected $ExpectedAccountId, got $($identity.Account)."
}
Write-Host "AWS account: $($identity.Account)"
Invoke-Aws -Arguments @('s3api', 'head-bucket', '--bucket', $BucketName) | Out-Null
if ($DistributionId) {
    $distribution = (Invoke-Aws -Arguments @('cloudfront', 'get-distribution', '--id', $DistributionId, '--output', 'json')) -join "`n" | ConvertFrom-Json
    $config = $distribution.Distribution.DistributionConfig
    $originId = $config.DefaultCacheBehavior.TargetOriginId
    $origins = @($config.Origins.Items | Where-Object { $_.Id -eq $originId })
    if ($origins.Count -ne 1) { throw 'Cannot identify the default CloudFront origin.' }
    $origin = $origins[0]
    $bucketDomainPattern = '^' + [regex]::Escape($BucketName) + '\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$'
    if ($origin.DomainName -notmatch $bucketDomainPattern -or $origin.OriginPath) {
        throw "Default CloudFront origin must point to the root of $BucketName via its S3 REST endpoint."
    }
    if (-not $config.Enabled -or $config.DefaultRootObject -ne 'index.html') {
        throw 'CloudFront must be enabled with Default root object set to index.html.'
    }
    if ($config.DefaultCacheBehavior.ViewerProtocolPolicy -notin @('redirect-to-https', 'https-only')) {
        throw 'CloudFront Viewer protocol policy must require HTTPS.'
    }
    $collectorUrl = "https://$($distribution.Distribution.DomainName)/"
} else {
    $location = (Invoke-Aws -Arguments @('s3api', 'get-bucket-location', '--bucket', $BucketName, '--output', 'json')) -join "`n" | ConvertFrom-Json
    $bucketRegion = $location.LocationConstraint
    if (-not $bucketRegion) { $bucketRegion = 'us-east-1' }
    if ($bucketRegion -eq 'EU') { $bucketRegion = 'eu-west-1' }
    $collectorUrl = "https://$BucketName.s3.$bucketRegion.amazonaws.com/site/index.html"
}

if (-not $PSCmdlet.ShouldProcess($destination, 'Build and deploy collector')) {
    return
}

Push-Location $collectorPath
try {
    Invoke-Npm -Arguments @('ci')
    Invoke-Npm -Arguments @('test')
    Invoke-Npm -Arguments @('run', 'build')
} finally {
    Pop-Location
}
if (-not (Test-Path -LiteralPath (Join-Path $distPath 'index.html') -PathType Leaf)) {
    throw 'Build output dist/index.html is missing. Deployment stopped.'
}

# 古い assets は開いている画面から参照されるため、削除しない。
# 全ファイルのメタデータを更新するため、sync ではなく cp を使用する。
Invoke-Aws -Arguments @('s3', 'cp', $distPath, $destination, '--recursive', '--exclude', 'index.html', '--exclude', 'assets/*', '--cache-control', 'no-cache', '--only-show-errors') | Out-Host
Invoke-Aws -Arguments @('s3', 'cp', (Join-Path $distPath 'assets'), ($destination + 'assets/'), '--recursive', '--cache-control', 'public,max-age=31536000,immutable', '--only-show-errors') | Out-Host
# assets の転送成功後にトップページを切り替える。
Invoke-Aws -Arguments @('s3', 'cp', (Join-Path $distPath 'index.html'), ($destination + 'index.html'), '--content-type', 'text/html', '--cache-control', 'no-cache', '--only-show-errors') | Out-Host
if ($DistributionId) {
    $invalidation = (Invoke-Aws -Arguments @('cloudfront', 'create-invalidation', '--distribution-id', $DistributionId, '--paths', '/*', '--output', 'json')) -join "`n" | ConvertFrom-Json
    $invalidationId = $invalidation.Invalidation.Id
    Write-Host "Invalidation: $invalidationId (waiting for completion)"
    Invoke-Aws -Arguments @('cloudfront', 'wait', 'invalidation-completed', '--distribution-id', $DistributionId, '--id', $invalidationId) | Out-Null
}
Write-Host "Collector deployed: $collectorUrl"
