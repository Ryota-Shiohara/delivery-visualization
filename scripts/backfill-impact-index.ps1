#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ResultFile = (Join-Path (Split-Path $PSScriptRoot -Parent) '.local/deploy-all/result.json'),
    [string]$EnvFile = (Join-Path (Split-Path $PSScriptRoot -Parent) '.env'),
    [ValidateRange(1, 10000)][int]$PageSize = 10000,
    [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Field($Object, [string]$Name) {
    if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) { return $Object.$Name }
    return $null
}
$result = Get-Content -LiteralPath $ResultFile -Raw | ConvertFrom-Json
$table = [string](Field $result 'AnalysisTableName')
$region = [string](Field $result 'Region')
$account = [string](Field $result 'AccountId')
if ($table -notmatch '^[A-Za-z0-9_.-]{3,255}$' -or -not $region -or $account -notmatch '^\d{12}$') {
    throw 'ResultFile must contain AnalysisTableName, Region and AccountId from deploy-all.'
}
$options = @{ EnvFile = $EnvFile; Region = $region }
function Invoke-AwsJson([string[]]$Arguments) {
    $output = & (Join-Path $PSScriptRoot 'aws-with-env.ps1') @options -Arguments $Arguments
    if ($PSVersionTable.PSVersion -ge [version]'7.5') {
        return (($output -join "`n") | ConvertFrom-Json -DateKind String)
    }
    return (($output -join "`n") | ConvertFrom-Json)
}
$identity = Invoke-AwsJson @('sts', 'get-caller-identity', '--output', 'json')
if ($identity.Account -ne $account) { throw 'AWS account differs from ResultFile. No data was updated.' }
$description = Invoke-AwsJson @('dynamodb', 'describe-table', '--table-name', $table, '--output', 'json')
$keys = @($description.Table.KeySchema)
$definitions = @($description.Table.AttributeDefinitions | Where-Object AttributeName -eq 'measurementId')
if ($keys.Count -ne 1 -or $keys[0].AttributeName -ne 'measurementId' -or $keys[0].KeyType -ne 'HASH' -or $definitions.Count -ne 1 -or $definitions[0].AttributeType -ne 'S') {
    throw 'Expected an analysis table with a single string measurementId primary key.'
}
Write-Host "Account: $account / Region: $region / AnalysisTable: $table / Apply: $Apply"
$inputPath = Join-Path ([IO.Path]::GetTempPath()) ('impact-backfill-' + [guid]::NewGuid().ToString() + '.json')
function Invoke-Dynamo([string]$Operation, $InputObject) {
    [IO.File]::WriteAllText($inputPath, ($InputObject | ConvertTo-Json -Depth 30 -Compress), (New-Object Text.UTF8Encoding($false)))
    Invoke-AwsJson @('dynamodb', $Operation, '--cli-input-json', "file://$inputPath", '--no-paginate', '--output', 'json')
}
$scanned = 0; $candidates = 0; $updated = 0; $existing = 0; $invalid = 0; $pages = 0
$startKey = $null
try {
    do {
        $request = @{
            TableName = $table; Limit = $PageSize; ConsistentRead = $true
            ProjectionExpression = '#id, #delivery, #time, #impact, #index'
            ExpressionAttributeNames = @{ '#id' = 'measurementId'; '#delivery' = 'deliveryId'; '#time' = 'measuredAt'; '#impact' = 'isImpact'; '#index' = 'impactDeliveryId' }
        }
        if ($startKey) { $request.ExclusiveStartKey = $startKey }
        $page = Invoke-Dynamo 'scan' $request
        $pages++
        $pending = @()
        foreach ($item in @($page.Items)) {
            $scanned++
            if ((Field (Field $item 'isImpact') 'BOOL') -ne $true) { continue }
            $id = Field (Field $item 'measurementId') 'S'
            $delivery = Field (Field $item 'deliveryId') 'S'
            $time = Field (Field $item 'measuredAt') 'S'
            if (-not $id -or -not $delivery -or -not $time -or [Text.Encoding]::UTF8.GetByteCount($delivery) -gt 2048 -or [Text.Encoding]::UTF8.GetByteCount($time) -gt 1024) { $invalid++; continue }
            $index = Field $item 'impactDeliveryId'
            if ($null -ne $index) {
                if ((Field $index 'S') -cne $delivery) { throw 'An existing impactDeliveryId conflicts with deliveryId. No overwrite was performed.' }
                $existing++; continue
            }
            $candidates++
            if ($Apply) {
                $update = @{
                    TableName = $table; Key = @{ measurementId = @{ S = $id } }
                    UpdateExpression = 'SET #index = :delivery'
                    ConditionExpression = 'attribute_exists(#id) AND #impact = :yes AND #delivery = :delivery AND #time = :time AND attribute_not_exists(#index)'
                    ExpressionAttributeNames = $request.ExpressionAttributeNames
                    ExpressionAttributeValues = @{ ':delivery' = @{ S = $delivery }; ':time' = @{ S = $time }; ':yes' = @{ BOOL = $true } }
                }
                $pending += @{ Update = $update }
                if ($pending.Count -eq 10) {
                    Invoke-Dynamo 'transact-write-items' @{ TransactItems = $pending; ClientRequestToken = [guid]::NewGuid().ToString() } | Out-Null
                    $updated += $pending.Count
                    $pending = @()
                }
            }
        }
        if ($pending.Count) {
            Invoke-Dynamo 'transact-write-items' @{ TransactItems = $pending; ClientRequestToken = [guid]::NewGuid().ToString() } | Out-Null
            $updated += $pending.Count
        }
        $startKey = Field $page 'LastEvaluatedKey'
        if ($null -ne $startKey -and @($startKey.PSObject.Properties).Count -eq 0) { $startKey = $null }
        Write-Host "Pages=$pages Scanned=$scanned Candidates=$candidates Updated=$updated Existing=$existing Invalid=$invalid"
    } while ($startKey)
    [pscustomobject]@{ TableName = $table; Apply = [bool]$Apply; Scanned = $scanned; Candidates = $candidates; Updated = $updated; Existing = $existing; Invalid = $invalid }
} finally {
    if (Test-Path -LiteralPath $inputPath) { Remove-Item -LiteralPath $inputPath }
}
