#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'backfill-impact-index.ps1'
$testResult = Join-Path ([IO.Path]::GetTempPath()) ('impact-test-' + [guid]::NewGuid().ToString() + '.json')
$testEnv = $testResult + '.env'
$global:impactTestWrites = 0
$global:impactTestScans = 0
$global:impactTestMismatch = $false
$global:impactTestBulk = $false
$global:impactTestBatchSizes = @()
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function aws {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'sts') {
        if ($global:impactTestMismatch) { return '{"Account":"999999999999"}' }
        return '{"Account":"123456789012"}'
    }
    if ($args[1] -eq 'describe-table') { return '{"Table":{"KeySchema":[{"AttributeName":"measurementId","KeyType":"HASH"}],"AttributeDefinitions":[{"AttributeName":"measurementId","AttributeType":"S"}]}}' }
    $inputIndex = [array]::IndexOf($args, '--cli-input-json')
    $json = Get-Content -LiteralPath ($args[$inputIndex + 1].Substring(7)) -Raw
    $inputObject = if ($PSVersionTable.PSVersion -ge [version]'7.5') { $json | ConvertFrom-Json -DateKind String } else { $json | ConvertFrom-Json }
    if ($args[1] -eq 'scan') {
        Assert ($inputObject.TableName -eq 'test-analysis') 'Wrong table selected.'
        $global:impactTestScans++
        if ($global:impactTestScans % 2 -eq 1) {
            Assert (-not $inputObject.PSObject.Properties['ExclusiveStartKey']) 'Unexpected start key.'
            return '{"Items":[],"LastEvaluatedKey":{"measurementId":{"S":"previous"}}}'
        }
        Assert ($inputObject.ExclusiveStartKey.measurementId.S -eq 'previous') 'Missing pagination.'
        if ($global:impactTestBulk) {
            $items = @(1..23 | ForEach-Object { @{ measurementId = @{ S = "bulk-$_" }; deliveryId = @{ S = 'delivery' }; measuredAt = @{ S = '2026-10-19T00:00:00Z' }; isImpact = @{ BOOL = $true } } })
            return (@{ Items = $items } | ConvertTo-Json -Depth 10 -Compress)
        }
        return '{"Items":[{"measurementId":{"S":"normal"},"isImpact":{"BOOL":false}},{"measurementId":{"S":"new"},"deliveryId":{"S":"delivery"},"measuredAt":{"S":"2026-10-19T00:00:00Z"},"isImpact":{"BOOL":true}},{"measurementId":{"S":"existing"},"deliveryId":{"S":"delivery"},"measuredAt":{"S":"2026-10-19T00:00:00Z"},"isImpact":{"BOOL":true},"impactDeliveryId":{"S":"delivery"}},{"measurementId":{"S":"invalid"},"isImpact":{"BOOL":true}}]}'
    }
    Assert ($args[1] -eq 'transact-write-items') 'Unexpected AWS operation.'
    $batchSize = @($inputObject.TransactItems).Count
    Assert ($batchSize -ge 1 -and $batchSize -le 10) 'Wrong update batch size.'
    $global:impactTestBatchSizes += $batchSize
    Assert ([bool]$inputObject.ClientRequestToken) 'Missing idempotency token.'
    $inputObject = $inputObject.TransactItems[0].Update
    Assert ($inputObject.TableName -eq 'test-analysis') 'Wrong update table selected.'
    $global:impactTestWrites += $batchSize
    Assert ($inputObject.Key.measurementId.S -eq 'new' -or $inputObject.Key.measurementId.S -like 'bulk-*') 'Non-target record was updated.'
    Assert ($inputObject.ExpressionAttributeValues.':delivery'.S -eq 'delivery') 'Wrong index value.'
    Assert ($inputObject.ConditionExpression -match 'attribute_exists\(#id\)' -and $inputObject.ConditionExpression -match 'attribute_not_exists\(#index\)' -and $inputObject.ConditionExpression -match '#impact = :yes') 'Missing concurrent update protection.'
    return '{}'
}
try {
    [IO.File]::WriteAllText($testResult, '{"AccountId":"123456789012","Region":"us-east-1","AnalysisTableName":"test-analysis","SummaryTableName":"test-summary","CellTableName":"test-cell"}')
    [IO.File]::WriteAllText($testEnv, "AWS_ACCESS_KEY_ID=fake`nAWS_SECRET_ACCESS_KEY=fake`nAWS_SESSION_TOKEN=fake`nAWS_REGION=us-east-1")
    $dry = & $scriptPath -ResultFile $testResult -EnvFile $testEnv
    Assert ($dry.Candidates -eq 1 -and $dry.Existing -eq 1 -and $dry.Invalid -eq 1 -and $dry.Scanned -eq 4) 'Incorrect dry-run counts.'
    Assert ($global:impactTestWrites -eq 0) 'Dry-run wrote data.'
    $applied = & $scriptPath -ResultFile $testResult -EnvFile $testEnv -Apply
    Assert ($applied.Updated -eq 1 -and $global:impactTestWrites -eq 1) 'Apply updated wrong count.'
    $global:impactTestBulk = $true
    $bulk = & $scriptPath -ResultFile $testResult -EnvFile $testEnv -Apply
    Assert ($bulk.Updated -eq 23 -and $global:impactTestWrites -eq 24) 'Bulk update lost records.'
    Assert (($global:impactTestBatchSizes -join ',') -eq '1,10,10,3') 'Bulk updates did not split at ten records.'
    $global:impactTestMismatch = $true
    try { & $scriptPath -ResultFile $testResult -EnvFile $testEnv -Apply; throw 'Expected account failure.' }
    catch { Assert ($_.Exception.Message -like 'AWS account differs*') 'Wrong account was not rejected.' }
    Assert ($global:impactTestScans -eq 6 -and $global:impactTestWrites -eq 24) 'Account mismatch accessed table.'
    Write-Host 'Impact backfill tests passed.'
} finally {
    Remove-Item -LiteralPath $testResult, $testEnv
    Remove-Item Function:\aws
    Remove-Variable impactTestWrites, impactTestScans, impactTestMismatch, impactTestBulk, impactTestBatchSizes -Scope Global
}
