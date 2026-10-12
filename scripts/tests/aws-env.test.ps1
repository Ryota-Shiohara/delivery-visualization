#Requires -Version 5.1
# AWS CLI / npm はすべてモックし、AWS通信やデプロイは行わない。
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptsPath = Split-Path $PSScriptRoot -Parent
$wrapper = Join-Path $scriptsPath 'aws-with-env.ps1'
$deploy = Join-Path $scriptsPath 'deploy-collector.ps1'
$envPath = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + '.env')
$savedAccessKey = [Environment]::GetEnvironmentVariable('AWS_ACCESS_KEY_ID', 'Process')
$savedFileEncoding = [Environment]::GetEnvironmentVariable('AWS_CLI_FILE_ENCODING', 'Process')
$global:awsEnvTestAwsCalls = 0
$global:awsEnvTestAwsExitCode = 0
$global:awsEnvTestNpmExitCode = 1
$global:awsEnvTestExpectedKey = 'fake-key'
$global:awsEnvTestExpectedRegion = 'ap-northeast-1'

function Assert {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function aws {
    $global:awsEnvTestAwsCalls++
    Assert ($env:AWS_CLI_FILE_ENCODING -eq 'UTF-8') 'AWS CLI file encoding is not UTF-8.'
    Assert ([string]$env:AWS_ACCESS_KEY_ID -eq [string]$global:awsEnvTestExpectedKey) "Credential selection failed at mock call $global:awsEnvTestAwsCalls."
    if ($global:awsEnvTestExpectedKey) {
        Assert ($env:AWS_SECRET_ACCESS_KEY -eq 'fake=secret') 'Quoted value parsing failed.'
        Assert ($env:AWS_SESSION_TOKEN -eq 'fake-token') 'Session token missing.'
    }
    $regionIndex = [array]::IndexOf($args, '--region')
    Assert ($args[$regionIndex + 1] -eq $global:awsEnvTestExpectedRegion) 'Region precedence failed.'
    $global:LASTEXITCODE = $global:awsEnvTestAwsExitCode
    if ($global:awsEnvTestAwsExitCode) { return }
    if ($args[0] -eq 'sts') { return '{"Account":"123456789012"}' }
    if ($args[0] -eq 'cloudfront' -and $global:awsEnvTestNpmExitCode -eq 0) {
        throw 'S3-only deployment called CloudFront.'
    }
    if ($args[1] -eq 'get-bucket-location') { return '{"LocationConstraint":null}' }
    if ($args[0] -eq 's3' -and $args[1] -eq 'cp') {
        Assert ($args[3] -like 's3://test-collector/site/*') 'Wrong S3-only upload prefix.'
    }
    if ($args[1] -eq 'get-distribution') {
        return '{"Distribution":{"DomainName":"example.cloudfront.net","DistributionConfig":{"Enabled":true,"DefaultRootObject":"index.html","DefaultCacheBehavior":{"TargetOriginId":"collector","ViewerProtocolPolicy":"redirect-to-https"},"Origins":{"Items":[{"Id":"collector","DomainName":"test-collector.s3.amazonaws.com","OriginPath":""}]}}}}'
    }
}

function npm {
    Assert ($env:AWS_ACCESS_KEY_ID -eq 'previous-key') 'File credentials leaked to npm.'
    $global:LASTEXITCODE = $global:awsEnvTestNpmExitCode
}

function Write-TestEnv {
    param([string]$Content)
    [System.IO.File]::WriteAllText($envPath, $Content)
}

try {
    [Environment]::SetEnvironmentVariable('AWS_ACCESS_KEY_ID', 'previous-key', 'Process')
    [Environment]::SetEnvironmentVariable('AWS_CLI_FILE_ENCODING', 'cp932', 'Process')
    Write-TestEnv "# comment`nexport AWS_ACCESS_KEY_ID='fake-key'`nAWS_SECRET_ACCESS_KEY=`"fake=secret`"`nAWS_SESSION_TOKEN=fake-token`nAWS_REGION=ap-northeast-1`n"
    & $wrapper -EnvFile $envPath -Arguments @('sts', 'get-caller-identity') | Out-Null
    Assert ($env:AWS_ACCESS_KEY_ID -eq 'previous-key') 'Environment was not restored after success.'
    Assert ($env:AWS_CLI_FILE_ENCODING -eq 'cp932') 'File encoding was not restored after success.'
    $global:awsEnvTestExpectedRegion = 'us-east-1'
    & $wrapper -EnvFile $envPath -Region us-east-1 -Arguments @('sts', 'get-caller-identity') | Out-Null
    $global:awsEnvTestAwsExitCode = 1
    try {
        & $wrapper -EnvFile $envPath -Arguments @('sts', 'get-caller-identity') -Region us-east-1 | Out-Null
        throw 'Expected CLI failure.'
    } catch { Assert ($_.Exception.Message -like 'AWS CLI failed*') 'Unexpected failure.' }
    Assert ($env:AWS_ACCESS_KEY_ID -eq 'previous-key') 'Environment was not restored after failure.'
    Assert ($env:AWS_CLI_FILE_ENCODING -eq 'cp932') 'File encoding was not restored after failure.'
    $global:awsEnvTestAwsExitCode = 0

    # Profile は.envを読まず、既存の環境変数認証も除外する。
    $global:awsEnvTestExpectedKey = $null
    & $wrapper -Profile academy -Arguments @('sts', 'get-caller-identity') | Out-Null
    Assert ($env:AWS_ACCESS_KEY_ID -eq 'previous-key') 'Profile mode failed to restore environment.'
    $global:awsEnvTestExpectedKey = 'fake-key'

    $global:awsEnvTestExpectedRegion = 'ap-northeast-1'
    $beforeDeploy = $global:awsEnvTestAwsCalls
    try {
        & $deploy -EnvFile $envPath -BucketName test-collector -DistributionId E123
        throw 'Expected npm failure.'
    } catch { Assert ($_.Exception.Message -like 'npm ci failed*') 'Deployment did not stop at npm.' }
    Assert ($global:awsEnvTestAwsCalls -eq $beforeDeploy + 3) 'AWS write occurred after npm failure.'

    $global:awsEnvTestNpmExitCode = 0
    $beforeS3 = $global:awsEnvTestAwsCalls
    & $deploy -EnvFile $envPath -BucketName test-collector
    Assert ($global:awsEnvTestAwsCalls -eq $beforeS3 + 6) 'Unexpected S3-only command sequence.'

    $beforePreview = $global:awsEnvTestAwsCalls
    & $deploy -EnvFile ($envPath + '.missing') -BucketName test-collector -DistributionId E123 -WhatIf
    Assert ($global:awsEnvTestAwsCalls -eq $beforePreview) 'WhatIf contacted AWS.'

    foreach ($invalid in @(
        "AWS_ACCESS_KEY_ID=fake-key`nAWS_SECRET_ACCESS_KEY=fake-secret",
        "AWS_ACCESS_KEY_ID=do-not-print`nAWS_ACCESS_KEY_ID=do-not-print",
        'UNKNOWN_KEY=do-not-print',
        'do-not-print',
        'AWS_ACCESS_KEY_ID="do-not-print'
    )) {
        Write-TestEnv $invalid
        $beforeInvalid = $global:awsEnvTestAwsCalls
        try {
            & $wrapper -EnvFile $envPath -Arguments @('sts', 'get-caller-identity') | Out-Null
            throw 'Expected invalid env failure.'
        } catch {
            Assert ($_.Exception.Message -notlike '*do-not-print*') 'Error leaked a credential value.'
            Assert ($_.Exception.Message -ne 'Expected invalid env failure.') 'Invalid file accepted.'
        }
        Assert ($global:awsEnvTestAwsCalls -eq $beforeInvalid) 'Invalid env contacted AWS.'
    }
    Write-Host 'PASS: parsing, credential selection, region override, UTF-8 file encoding, environment restoration, profile mode, npm isolation, offline WhatIf and invalid env rejection.'
} finally {
    [Environment]::SetEnvironmentVariable('AWS_ACCESS_KEY_ID', $savedAccessKey, 'Process')
    [Environment]::SetEnvironmentVariable('AWS_CLI_FILE_ENCODING', $savedFileEncoding, 'Process')
    if (Test-Path -LiteralPath $envPath) { Remove-Item -LiteralPath $envPath }
    Remove-Variable -Scope Global -Name awsEnvTestAwsCalls, awsEnvTestAwsExitCode, awsEnvTestNpmExitCode, awsEnvTestExpectedKey, awsEnvTestExpectedRegion
}
