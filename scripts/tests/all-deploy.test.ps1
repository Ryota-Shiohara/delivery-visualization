#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$fixture = Join-Path $root ('.local/all-deploy-test-' + [guid]::NewGuid().ToString('N'))
$savedKey = $env:AWS_ACCESS_KEY_ID
$global:allDeployCalls = [Collections.Generic.List[string]]::new()
$global:failAnalysis = $false
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
function sam {
    $global:allDeployCalls.Add('sam:' + ($args -join ' '))
    if ($args[0] -eq 'build') {
        Assert ($env:AWS_ACCESS_KEY_ID -eq 'previous-key') 'Build received deployment credentials.'
    } else {
        Assert ($env:AWS_ACCESS_KEY_ID -eq 'test-key') 'SAM deploy did not receive .env credentials.'
        Assert (($args -join ' ') -match '--region ap-northeast-1') 'SAM ignored .env region.'
        if ($global:failAnalysis -and ($args -join ' ') -match '--stack-name delivery-visualization-c') { $global:LASTEXITCODE = 9; return }
    }
    $global:LASTEXITCODE = 0
}
function aws {
    $global:allDeployCalls.Add('aws:' + ($args -join ' '))
    Assert ($env:AWS_ACCESS_KEY_ID -eq 'test-key') 'AWS did not receive .env credentials.'
    Assert (($args -join ' ') -match '--region ap-northeast-1') 'AWS ignored .env region.'
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'sts') { return '{"Account":"123456789012"}' }
    if ($args[1] -eq 'describe-stacks') {
        $name = $args[[array]::IndexOf($args, '--stack-name') + 1]
        $values = switch ($name) {
            'delivery-visualization-b' { @{MeasurementApiUrl='https://new-api.example/dev/measurements';MeasurementsStreamArn='arn:aws:dynamodb:ap-northeast-1:123456789012:table/test/stream/test'} }
            'delivery-visualization-c' { @{AnalysisTableName='c-analysis';SummaryTableName='c-summary';CellTableName='c-cell'} }
            'delivery-collector-s3' { @{BucketName='collector-test';CollectorUrl='https://collector-test.example/site/index.html'} }
            'delivery-collector-cloudfront' { @{BucketName='collector-test';CollectorUrl='https://collector-test.example/';DistributionId='E123'} }
            default { throw "Unexpected stack $name" }
        }
        return (@{Stacks=@(@{Outputs=@($values.GetEnumerator() | ForEach-Object { @{OutputKey=$_.Key;OutputValue=$_.Value} })})} | ConvertTo-Json -Depth 6 -Compress)
    }
    Assert ($args[1] -eq 'deploy') 'Unexpected AWS operation.'
}
try {
    New-Item -ItemType Directory -Path (Join-Path $fixture 'scripts'), (Join-Path $fixture 'infra') -Force | Out-Null
    foreach ($name in @('deploy-all.ps1','deploy-sam.ps1','aws-with-env.ps1','read-deployment-region.ps1')) {
        Copy-Item -LiteralPath (Join-Path $root "scripts/$name") -Destination (Join-Path $fixture "scripts/$name")
    }
    foreach ($name in @('deploy.ps1','template.yaml','analysis.yaml','collector-s3.yaml','collector.yaml')) {
        Copy-Item -LiteralPath (Join-Path $root "infra/$name") -Destination (Join-Path $fixture "infra/$name")
    }
    @'
param($EnvFile,$Region,$StackName,$TableMode,$AnalysisTableName,$SummaryTableName,$CellTableName,$ExpectedAccountId)
Assert ($Region -eq 'ap-northeast-1' -and $AnalysisTableName -eq 'c-analysis' -and $SummaryTableName -eq 'c-summary' -and $CellTableName -eq 'c-cell' -and $TableMode -eq 'existing') 'D received incorrect wiring.'
Assert ($env:AWS_ACCESS_KEY_ID -eq 'previous-key') 'D process received leaked credentials.'
$global:allDeployCalls.Add('dashboard')
[pscustomobject]@{DashboardUrl='https://dashboard.example/';ApiBaseUrl='https://query.example/'}
'@ | Set-Content -LiteralPath (Join-Path $fixture 'scripts/deploy-dashboard.ps1') -Encoding utf8
    @'
param($EnvFile,$Region,$BucketName,$MeasurementApiUrl,$ExpectedAccountId,$DistributionId)
Assert ($MeasurementApiUrl -eq 'https://new-api.example/dev/measurements' -and $BucketName -eq 'collector-test') 'Collector received incorrect wiring.'
Assert ($env:AWS_ACCESS_KEY_ID -eq 'previous-key') 'Collector process received leaked credentials.'
$global:allDeployCalls.Add('collector:' + $DistributionId)
'@ | Set-Content -LiteralPath (Join-Path $fixture 'scripts/deploy-collector.ps1') -Encoding utf8
    "AWS_ACCESS_KEY_ID=test-key`nAWS_SECRET_ACCESS_KEY=test-secret`nAWS_SESSION_TOKEN=test-session`nAWS_REGION=ap-northeast-1" | Set-Content -LiteralPath (Join-Path $fixture '.env') -Encoding utf8
    $env:AWS_ACCESS_KEY_ID = 'previous-key'
    $script = Join-Path $fixture 'scripts/deploy-all.ps1'
    & $script -EnvFile missing.env -WhatIf
    Assert ($global:allDeployCalls.Count -eq 0) 'WhatIf executed commands.'
    $result = & $script -ExpectedAccountId 123456789012
    Assert ($result.Region -eq 'ap-northeast-1' -and $result.QueryApiUrl -eq 'https://query.example/') 'Incorrect final result.'
    $calls = $global:allDeployCalls -join "`n"
    Assert ($calls -match '(?s)deploy.*delivery-visualization-b.*deploy.*delivery-visualization-c.*dashboard.*deploy.*delivery-collector-s3.*collector:') 'Wrong dependency order.'
    Assert ($calls -match 'MeasurementsStreamArn=arn:aws:dynamodb') 'C did not receive stream ARN.'
    Assert ($env:AWS_ACCESS_KEY_ID -eq 'previous-key') 'Credentials were not restored.'
    $global:allDeployCalls.Clear()
    & $script -CollectorHosting cloudfront -CollectorStack delivery-collector-cloudfront | Out-Null
    Assert ($global:allDeployCalls.Contains('collector:E123')) 'CloudFront distribution was not passed.'
    $global:allDeployCalls.Clear()
    $global:failAnalysis = $true
    try { & $script | Out-Null; throw 'Expected SAM failure.' } catch { Assert ($_.Exception.Message -like 'SAM CLI failed*') 'Wrong failure.' }
    Assert (-not $global:allDeployCalls.Contains('dashboard')) 'D ran after C failed.'
    Assert ($env:AWS_ACCESS_KEY_ID -eq 'previous-key') 'Failure leaked credentials.'
    $global:allDeployCalls.Clear()
    try { & $script -ExpectedAccountId 999999999999 | Out-Null; throw 'Expected mismatch.' } catch { Assert ($_.Exception.Message -eq 'AWS account mismatch.') 'Wrong account failure.' }
    Assert ($global:allDeployCalls.Count -eq 1) 'Account mismatch caused deployment.'
    Write-Host 'PASS: offline preview, S3/CloudFront wiring, .env region, SAM credential scope/restoration, failure stop and account guard; AWS and SAM entirely mocked.'
} finally {
    $env:AWS_ACCESS_KEY_ID = $savedKey
    # GUID付きのテスト専用ディレクトリが.local配下であることを確認して削除する。
    $localRoot = [IO.Path]::GetFullPath((Join-Path $root '.local')) + [IO.Path]::DirectorySeparatorChar
    if (-not [IO.Path]::GetFullPath($fixture).StartsWith($localRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path.' }
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
    Remove-Variable -Scope Global -Name allDeployCalls,failAnalysis
}
