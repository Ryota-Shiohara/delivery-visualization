#Requires -Version 5.1
param([Parameter(Mandatory = $true)][string]$NodePath)
# AWS CLIとHTTPSをモックし、実際のAWSリソースを作成しない。
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$deploy = Join-Path $repoRoot 'scripts\deploy-dashboard.ps1'
$global:dTestCalls = New-Object 'System.Collections.Generic.List[object]'
$global:dTestHttp = New-Object 'System.Collections.Generic.List[string]'
$global:dTestMode = 'prototype'
$global:dTestExistingMode = ''
$global:dTestSeedExists = $false
$global:dTestFailDeploy = $false
$global:dTestBadCors = $false
$global:dTestStackName = 'd-test'
function Assert {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}
function ArgValue {
    param([object[]]$Arguments, [string]$Key)
    $index = [array]::IndexOf($Arguments, $Key)
    if ($index -lt 0) { throw "Missing CLI option $Key" }
    return $Arguments[$index + 1]
}
function aws {
    $call = @($args)
    $global:dTestCalls.Add($call)
    $global:LASTEXITCODE = 0
    Assert ($env:AWS_CLI_FILE_ENCODING -eq 'UTF-8') 'AWS wrapper was bypassed.'
    if ($call[0] -eq 'sts') { return '{"Account":"123456789012"}' }
    if ($call[0] -eq 'cloudfront' -or $call[0] -eq 'iam' -or $call[0] -eq 's3control') { throw 'Unexpected service mutation.' }
    if ($call[1] -eq 'list-stacks') {
        if ($global:dTestExistingMode) { return (@{ StackSummaries = @(@{ StackName = "$($global:dTestStackName)-backend"; StackStatus = 'UPDATE_COMPLETE' }) } | ConvertTo-Json -Depth 5) }
        return '{"StackSummaries":[]}'
    }
    if ($call[1] -eq 'describe-stacks') {
        $name = ArgValue $call '--stack-name'
        if ($name.EndsWith('-storage')) {
            $values = @{ DeploymentKind = 'DDashboardStorageV1'; DashboardBucketName = 'd-test-web'; ArtifactBucketName = 'd-test-private'; DashboardUrl = 'https://d-test-web.s3.us-east-1.amazonaws.com/dashboard/index.html' }
        } else {
            $mode = if ($global:dTestExistingMode) { $global:dTestExistingMode } else { $global:dTestMode }
            $values = @{ DeploymentKind = 'DDashboardBackendV1'; TableMode = $mode; ApiBaseUrl = 'https://example.execute-api.us-east-1.amazonaws.com'; QueryFunctionName = 'd-query'; AnalysisTableName = 'd-analysis'; SummaryTableName = 'd-summary'; CellTableName = 'd-cell' }
        }
        $outputs = @($values.GetEnumerator() | ForEach-Object { @{ OutputKey = $_.Key; OutputValue = $_.Value } })
        return (ConvertTo-Json -InputObject @{ Stacks = @(@{ Outputs = $outputs }) } -Depth 8)
    }
    if ($call[1] -eq 'describe-table') { return '{"Table":{"TableStatus":"ACTIVE"}}' }
    if ($call[0] -eq 'cloudformation' -and $call[1] -eq 'deploy') {
        if ($global:dTestFailDeploy) { $global:LASTEXITCODE = 1; return }
        if ((ArgValue $call '--stack-name').EndsWith('-backend')) {
            $parameterPath = (ArgValue $call '--parameter-overrides') -replace '^file://', ''
            $entries = Get-Content -Raw -Encoding UTF8 -LiteralPath $parameterPath | ConvertFrom-Json
            $parameters = @{}; foreach ($entry in $entries) { $parameters[$entry.ParameterKey] = $entry.ParameterValue }
            Assert ($parameters.TableMode -eq $global:dTestMode) 'Wrong table mode.'
            Assert ($parameters.LambdaCodeKey -match '^lambda/[a-f0-9]{64}\.zip$') 'Lambda code is not content-addressed.'
            Assert ($parameters.DashboardBucketName -eq 'd-test-web') 'Storage outputs not connected to backend.'
            if ($global:dTestMode -eq 'existing') { Assert ($parameters.AnalysisTableName -eq 'c-analysis') 'C table name was changed.' }
        }
        return
    }
    if ($call[1] -eq 'get-item') { if ($global:dTestSeedExists) { return '{"Item":{"existing":{"S":"kept"}}}' }; return '{}' }
    if ($call[1] -eq 'put-item') {
        Assert ($global:dTestMode -eq 'prototype') 'Existing C data was written.'
        Assert ((ArgValue $call '--condition-expression') -match '^attribute_not_exists\(') 'Sample can overwrite existing item.'
        return
    }
    if ($call[0] -eq 's3' -and $call[1] -eq 'cp') {
        Assert ($call[3] -match '^s3://d-test-(private/lambda/|web/dashboard/)') 'Wrong S3 destination.'
        return
    }
    if ($call[1] -eq 'validate-template') { return '{}' }
    throw "Unmocked AWS operation: $($call[0]) $($call[1])"
}
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, [string]$Uri, [hashtable]$Headers, [int]$TimeoutSec)
    $global:dTestHttp.Add($Uri)
    if ($Uri.EndsWith('/api/health')) {
        $cors = if ($global:dTestBadCors) { 'https://wrong.example' } else { $Headers.Origin }
        return [pscustomobject]@{ StatusCode = 200; Headers = @{ 'Access-Control-Allow-Origin' = $cors }; Content = '{"status":"ok","deployment":"aws","dataMode":"dynamodb"}' }
    }
    if ($Uri.EndsWith('/api/deliveries') -or $Uri.EndsWith('/api/cells')) { return [pscustomobject]@{ StatusCode = 200; Content = '{"items":[]}' } }
    if ($Uri.EndsWith('/index.html')) { return [pscustomobject]@{ StatusCode = 200; Headers = @{ 'Content-Type' = 'text/html' }; Content = '<html></html>' } }
    if ($Uri.EndsWith('/app.js')) { return [pscustomobject]@{ StatusCode = 200; Headers = @{ 'Content-Type' = 'text/javascript' }; Content = 'export {};' } }
    if ($Uri.EndsWith('/config.js')) { return [pscustomobject]@{ StatusCode = 200; Headers = @{ 'Content-Type' = 'text/javascript' }; Content = 'window.DASHBOARD_CONFIG={apiBaseUrl:"https://example.execute-api.us-east-1.amazonaws.com",deployment:"aws"};' } }
    throw 'Unexpected HTTPS request.'
}
function Start-Sleep { param([int]$Seconds) }
function Reset-Case {
    param([string]$Name)
    $global:dTestCalls.Clear(); $global:dTestHttp.Clear()
    $global:dTestMode = 'prototype'; $global:dTestExistingMode = ''; $global:dTestSeedExists = $false
    $global:dTestFailDeploy = $false; $global:dTestBadCors = $false
    $global:dTestStackName = 'd-test-' + $Name + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 6))
}
function Invoke-TestDeploy {
    param([hashtable]$Options = @{})
    & $deploy -Profile test-profile -NodePath $NodePath -StackName $global:dTestStackName @Options
}
function Expect-Failure {
    param([hashtable]$Options, [string]$Pattern)
    try { Invoke-TestDeploy $Options | Out-Null; throw 'Expected failure did not occur.' }
    catch { Assert ($_.Exception.Message -like $Pattern) "Wrong failure: $($_.Exception.Message)" }
}
function Count-Calls {
    param([string]$Operation)
    return @($global:dTestCalls | Where-Object { $_[1] -eq $Operation }).Count
}
try {
    Reset-Case preview
    Invoke-TestDeploy @{ TableMode = 'prototype'; WhatIf = $true }
    Assert ($global:dTestCalls.Count -eq 0 -and $global:dTestHttp.Count -eq 0) 'WhatIf contacted AWS.'
    Reset-Case missing
    Expect-Failure @{ TableMode = 'existing' } '*3つを指定*'
    Assert ($global:dTestCalls.Count -eq 0) 'Invalid arguments contacted AWS.'
    Reset-Case conflict
    Expect-Failure @{ TableMode = 'prototype'; AnalysisTableName = 'c-analysis' } '*既存テーブル名は指定*'
    Assert ($global:dTestCalls.Count -eq 0) 'Prototype accepted existing names.'
    Reset-Case account
    Expect-Failure @{ TableMode = 'prototype'; ExpectedAccountId = '999999999999' } '*アカウントが一致*'
    Assert ((Count-Calls deploy) -eq 0) 'Wrong account was deployed.'
    Reset-Case mode
    $global:dTestExistingMode = 'existing'
    Expect-Failure @{ TableMode = 'prototype' } '*TableModeは変更*'
    Assert ((Count-Calls deploy) -eq 0) 'Mode switch modified stack.'
    Reset-Case prototype
    $result = Invoke-TestDeploy @{ TableMode = 'prototype' }
    Assert ((Count-Calls deploy) -eq 2 -and (Count-Calls put-item) -eq 3) 'Prototype did not deploy two stacks and seed 3 tables.'
    Assert ($result.DashboardUrl -eq 'https://d-test-web.s3.us-east-1.amazonaws.com/dashboard/index.html') 'Wrong public URL.'
    $webCalls = @($global:dTestCalls | Where-Object { $_[0] -eq 's3' -and $_[3] -like 's3://d-test-web/*' })
    Assert ($webCalls.Count -eq 4 -and $webCalls[3][2].EndsWith('index.html')) 'HTML was not published last.'
    Assert ((ArgValue $webCalls[1] '--content-type') -eq 'text/javascript' -and (ArgValue $webCalls[2] '--content-type') -eq 'text/css') 'JS/CSS MIME types were not specified.'
    $config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $repoRoot '.local\aws-build\web\dashboard\config.js')
    Assert ($config -match 'example.execute-api' -and $config -notmatch 'YOUR_API_ID') 'config.js URL was not generated.'
    Reset-Case existing
    $global:dTestMode = 'existing'
    Invoke-TestDeploy @{ TableMode = 'existing'; AnalysisTableName = 'c-analysis'; SummaryTableName = 'c-summary'; CellTableName = 'c-cell' } | Out-Null
    Assert ((Count-Calls describe-table) -eq 3 -and (Count-Calls put-item) -eq 0 -and (Count-Calls get-item) -eq 0) 'Existing mode did not preserve C data.'
    Reset-Case replay
    $global:dTestSeedExists = $true
    Invoke-TestDeploy @{ TableMode = 'prototype' } | Out-Null
    Assert ((Count-Calls put-item) -eq 0) 'Repeated sample overwrote data.'
    Reset-Case empty
    Invoke-TestDeploy @{ TableMode = 'prototype'; SkipSampleData = $true } | Out-Null
    Assert ((Count-Calls put-item) -eq 0 -and (Count-Calls get-item) -eq 0) 'SkipSampleData seeded items.'
    Reset-Case cfnfail
    $global:dTestFailDeploy = $true
    Expect-Failure @{ TableMode = 'prototype' } 'AWS CLI failed*'
    Assert (@($global:dTestCalls | Where-Object { $_[0] -eq 's3' }).Count -eq 0) 'CloudFormation failure was followed by upload.'
    Reset-Case corsfail
    $global:dTestBadCors = $true
    Expect-Failure @{ TableMode = 'prototype' } '*CORS応答が一致*'
    Assert (-not (Test-Path -LiteralPath (Join-Path $repoRoot ".local\d-deploy\$($global:dTestStackName)\result.json"))) 'Failed deployment wrote success record.'
    Write-Host 'PASS: 11 deployment scenarios; AWS CLI and HTTPS entirely mocked.'
} finally {
    Remove-Variable -Scope Global -Name dTestCalls,dTestHttp,dTestMode,dTestExistingMode,dTestSeedExists,dTestFailDeploy,dTestBadCors,dTestStackName
}
