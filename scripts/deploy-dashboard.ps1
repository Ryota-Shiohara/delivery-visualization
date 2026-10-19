#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [ValidatePattern('^[A-Za-z][A-Za-z0-9-]{0,99}$')]
    [string]$StackName = 'delivery-visualization-d',
    [ValidateSet('existing', 'prototype')]
    [string]$TableMode = 'existing',
    [string]$AnalysisTableName,
    [string]$SummaryTableName,
    [string]$CellTableName,
    [switch]$SkipSampleData,
    [ValidateRange(1, 1000)]
    [int]$MaxPageItems = 1000,
    [ValidatePattern('^[A-Za-z0-9_.-]{3,255}$')]
    [string]$AnalysisIndexName = 'DeliveryTimeIndex',
    [ValidatePattern('^[A-Za-z0-9_.-]{3,255}$')]
    [string]$ImpactIndexName = 'ImpactDeliveryTimeIndex',
    [string]$Profile,
    [string]$EnvFile,
    [string]$Region,
    [ValidatePattern('^\d{12}$')]
    [string]$ExpectedAccountId,
    [string]$NodePath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$storageStack = "$StackName-storage"
$backendStack = "$StackName-backend"
$tableNames = @($AnalysisTableName, $SummaryTableName, $CellTableName)
if ($TableMode -eq 'existing') {
    foreach ($name in $tableNames) {
        if ($name -notmatch '^[A-Za-z0-9_.-]{3,255}$') { throw 'existingモードではAnalysisTableName、SummaryTableName、CellTableNameの3つを指定してください。' }
    }
    if (@($tableNames | Select-Object -Unique).Count -ne 3) { throw '結果テーブルは3種類を別々の名前で指定してください。' }
    if ($SkipSampleData) { throw 'SkipSampleDataはprototypeモード用です。existingでは項目登録を行いません。' }
} elseif (@($tableNames | Where-Object { $_ }).Count) { throw 'prototypeモードのテーブル名は自動生成します。既存テーブル名は指定しません。' }
if ($Profile -and $EnvFile) { throw 'ProfileとEnvFileはどちらか一方を指定してください。' }
# WhatIfは認証情報の読み込み・ローカル生成・AWS通信を行わない。
if ($WhatIfPreference) {
    Write-Host "Preview: account/stack/table checks in $Region; table mode=$TableMode"
    Write-Host "Preview: package Lambda; create/update $storageStack (dashboard + private artifact buckets)"
    Write-Host "Preview: upload Lambda ZIP; create/update $backendStack (HTTP API + Lambda + LabRole reference)"
    if ($TableMode -eq 'prototype') { Write-Host 'Preview: create 3 tables; insert missing sample IDs unless SkipSampleData is set' }
    else { Write-Host 'Preview: read existing C tables; no table creation or item writes' }
    Write-Host 'Preview: generate config.js, upload assets then index.html, check HTTPS/CORS/API'
    return
}
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw 'AWS CLI v2をインストールしてください。' }
if (-not $Region) {
    if ($Profile) { $Region = 'us-east-1' }
    else {
        $regionOptions = @{}
        if ($EnvFile) { $regionOptions.EnvFile = $EnvFile }
        $Region = & (Join-Path $PSScriptRoot 'read-deployment-region.ps1') @regionOptions
    }
}
if (-not $NodePath) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) { $NodePath = $nodeCommand.Source }
}
if (-not $NodePath -or -not (Get-Command $NodePath -ErrorAction SilentlyContinue)) { throw 'Node.js 20以上をインストールするか、NodePathにnode.exeの場所を指定してください。' }
$nodeVersion = & $NodePath --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) { throw 'Node.js 20以上が必要です。' }
$awsOptions = @{ Region = $Region }
if ($Profile) { $awsOptions.Profile = $Profile }
if ($EnvFile) { $awsOptions.EnvFile = $EnvFile }
function Invoke-DashboardAws {
    param([string[]]$Arguments)
    & (Join-Path $PSScriptRoot 'aws-with-env.ps1') -Arguments $Arguments @awsOptions
}
function Read-AwsJson {
    param([string[]]$Arguments)
    $lines = @(Invoke-DashboardAws -Arguments ($Arguments + @('--output', 'json')))
    ($lines -join "`n") | ConvertFrom-Json
}
function Write-Utf8File {
    param([string]$Path, [string]$Content)
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}
function Read-StackOutputs {
    param([string]$Name)
    $result = Read-AwsJson -Arguments @('cloudformation', 'describe-stacks', '--stack-name', $Name)
    $values = @{}
    foreach ($entry in $result.Stacks[0].Outputs) { $values[$entry.OutputKey] = $entry.OutputValue }
    return $values
}
function Wait-AnalysisIndex {
    param([string]$TableName, [string]$IndexName = $AnalysisIndexName, [string]$HashKey = 'deliveryId')
    $timer = [Diagnostics.Stopwatch]::StartNew()
    for ($attempt = 1; $attempt -le 120; $attempt++) {
        $description = Read-AwsJson -Arguments @('dynamodb', 'describe-table', '--table-name', $TableName)
        $indexes = if ($description.Table.PSObject.Properties['GlobalSecondaryIndexes']) { @($description.Table.GlobalSecondaryIndexes) } else { @() }
        $index = @($indexes | Where-Object { $_.IndexName -eq $IndexName })
        if ($index.Count -ne 1) { throw "解析結果テーブルに${IndexName}が必要です。Cのinfra/analysis.yamlを先に更新してください。" }
        if ($index[0].IndexStatus -eq 'ACTIVE') {
            $keys = @($index[0].KeySchema)
            if (@($keys | Where-Object { $_.AttributeName -eq $HashKey -and $_.KeyType -eq 'HASH' }).Count -ne 1 -or @($keys | Where-Object { $_.AttributeName -eq 'measuredAt' -and $_.KeyType -eq 'RANGE' }).Count -ne 1 -or $index[0].Projection.ProjectionType -ne 'ALL') {
                throw "索引のキーは$HashKey/measuredAt、ProjectionはALLにしてください。"
            }
            Write-Host "$IndexName はACTIVEです。dashboardの構築を続けます。"
            return
        }
        if ($index[0].IndexStatus -notin @('CREATING', 'UPDATING')) { throw '索引が利用できる状態ではありません。' }
        if ($attempt -eq 120) { throw '索引の準備待ちがタイムアウトしました。ACTIVEになってから再実行してください。' }
        if (($attempt - 1) % 6 -eq 0) {
            $elapsedSeconds = [int][Math]::Floor($timer.Elapsed.TotalSeconds)
            Write-Host "$IndexName の作成完了を待っています。Table=$TableName Status=$($index[0].IndexStatus) 経過=${elapsedSeconds}秒 確認=$attempt/120"
        }
        Start-Sleep -Seconds 5
    }
}
$identity = Read-AwsJson -Arguments @('sts', 'get-caller-identity')
if ($ExpectedAccountId -and $identity.Account -ne $ExpectedAccountId) { throw "AWSアカウントが一致しません。Expected=$ExpectedAccountId Actual=$($identity.Account)" }
Write-Host "AWS account: $($identity.Account), region: $Region, table mode: $TableMode"
# 同名の他担当スタックや、作成途中・失敗状態を自動で書き換えない。
$stacks = Read-AwsJson -Arguments @('cloudformation', 'list-stacks')
foreach ($name in @($storageStack, $backendStack)) {
    $found = @($stacks.StackSummaries | Where-Object { $_.StackName -eq $name -and $_.StackStatus -ne 'DELETE_COMPLETE' })
    if (-not $found.Count) { continue }
    if ($found.Count -ne 1 -or $found[0].StackStatus -notin @('CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE')) { throw "$name の状態をCloudFormationで確認してください。作成中・失敗スタックを自動削除しません。" }
    $existing = Read-StackOutputs -Name $name
    $expectedKind = if ($name -eq $storageStack) { 'DDashboardStorageV1' } else { 'DDashboardBackendV1' }
    if ($existing.DeploymentKind -ne $expectedKind) { throw "$name はこのD構築用スタックではありません。別のStackNameを指定してください。" }
    if ($name -eq $backendStack -and $existing.TableMode -ne $TableMode) { throw '同じスタックのTableModeは変更しません。別のStackNameで構築してください。' }
}
if ($TableMode -eq 'existing') {
    foreach ($name in $tableNames) {
        $table = Read-AwsJson -Arguments @('dynamodb', 'describe-table', '--table-name', $name)
        if ($table.Table.TableStatus -ne 'ACTIVE') { throw "$name がACTIVEではありません。" }
    }
    Wait-AnalysisIndex -TableName $AnalysisTableName
    Wait-AnalysisIndex -TableName $AnalysisTableName -IndexName $ImpactIndexName -HashKey 'impactDeliveryId'
}
if (-not $PSCmdlet.ShouldProcess("$($identity.Account)/$Region/$StackName", 'Create/update D resources and publish dashboard')) { return }
# パッケージ作成で失敗したらAWSへの書き込みを開始しない。
& (Join-Path $PSScriptRoot 'package-d-aws.ps1') -NodePath $NodePath | Out-Host
$lambdaZip = Join-Path $repoRoot '.local\artifacts\D担当_AWS参照Lambda.zip'
$webRoot = Join-Path $repoRoot '.local\aws-build\web\dashboard'
$workRoot = Join-Path $repoRoot ".local\d-deploy\$StackName"
New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
$lambdaHash = (Get-FileHash -LiteralPath $lambdaZip -Algorithm SHA256).Hash.ToLowerInvariant()
$codeKey = "lambda/$lambdaHash.zip"
try {
    foreach ($template in @('dashboard-storage.yaml', 'dashboard.yaml')) {
        $path = Join-Path $repoRoot "infra\$template"
        Invoke-DashboardAws -Arguments @('cloudformation', 'validate-template', '--template-body', "file://$path") | Out-Null
    }
    Invoke-DashboardAws -Arguments @('cloudformation', 'deploy', '--template-file', (Join-Path $repoRoot 'infra\dashboard-storage.yaml'), '--stack-name', $storageStack, '--no-fail-on-empty-changeset') | Out-Host
    $storage = Read-StackOutputs -Name $storageStack
    Invoke-DashboardAws -Arguments @('s3', 'cp', $lambdaZip, "s3://$($storage.ArtifactBucketName)/$codeKey", '--only-show-errors') | Out-Host
    # 空文字やスペースをWindowsのCLI引数で壊さないようJSONファイルで渡す。
    $parameters = @{
        DashboardBucketName = $storage.DashboardBucketName; ArtifactBucketName = $storage.ArtifactBucketName
        LambdaCodeKey = $codeKey; TableMode = $TableMode
        AnalysisTableName = [string]$AnalysisTableName; SummaryTableName = [string]$SummaryTableName; CellTableName = [string]$CellTableName
        MaxPageItems = [string]$MaxPageItems; AnalysisIndexName = $AnalysisIndexName; ImpactIndexName = $ImpactIndexName
    }
    $parameterList = @($parameters.GetEnumerator() | Sort-Object Name | ForEach-Object { @{ ParameterKey = $_.Key; ParameterValue = $_.Value } })
    $parameterFile = Join-Path $workRoot 'parameters.json'
    Write-Utf8File -Path $parameterFile -Content (ConvertTo-Json -InputObject $parameterList -Depth 5)
    Invoke-DashboardAws -Arguments @('cloudformation', 'deploy', '--template-file', (Join-Path $repoRoot 'infra\dashboard.yaml'), '--stack-name', $backendStack, '--parameter-overrides', "file://$parameterFile", '--no-fail-on-empty-changeset') | Out-Host
    $backend = Read-StackOutputs -Name $backendStack
    if ($TableMode -eq 'prototype') {
        Wait-AnalysisIndex -TableName $backend.AnalysisTableName
        Wait-AnalysisIndex -TableName $backend.AnalysisTableName -IndexName $ImpactIndexName -HashKey 'impactDeliveryId'
    }
    if ($TableMode -eq 'prototype' -and -not $SkipSampleData) {
        foreach ($sample in @(
            @{ Name = 'analysis'; Table = $backend.AnalysisTableName; Key = 'measurementId' },
            @{ Name = 'summary'; Table = $backend.SummaryTableName; Key = 'deliveryId' },
            @{ Name = 'cell'; Table = $backend.CellTableName; Key = 'cellId' }
        )) {
            $itemPath = Join-Path $repoRoot "infra\examples\d-dashboard\dynamodb-items\$($sample.Name).json"
            $item = Get-Content -Raw -Encoding UTF8 -LiteralPath $itemPath | ConvertFrom-Json
            $key = @{}; $key[$sample.Key] = $item.($sample.Key)
            $keyPath = Join-Path $workRoot "$($sample.Name)-key.json"
            Write-Utf8File -Path $keyPath -Content (ConvertTo-Json -InputObject $key -Depth 5)
            $getArgs = @('dynamodb', 'get-item', '--table-name', $sample.Table, '--key', "file://$keyPath", '--consistent-read')
            $current = Read-AwsJson -Arguments $getArgs
            if ($current.PSObject.Properties['Item']) { Write-Host "Sample already exists, kept: $($sample.Name)"; continue }
            try { Invoke-DashboardAws -Arguments @('dynamodb', 'put-item', '--table-name', $sample.Table, '--item', "file://$itemPath", '--condition-expression', "attribute_not_exists($($sample.Key))") | Out-Null }
            catch {
                # 先に同じIDが登録された場合も上書きしない。その他のエラーは停止する。
                $after = Read-AwsJson -Arguments $getArgs
                if (-not $after.PSObject.Properties['Item']) { throw }
            }
        }
    }
    $config = @{ apiBaseUrl = $backend.ApiBaseUrl; deployment = 'aws' } | ConvertTo-Json
    Write-Utf8File -Path (Join-Path $webRoot 'config.js') -Content "window.DASHBOARD_CONFIG = $config;`n"
    $destination = "s3://$($storage.DashboardBucketName)/dashboard/"
    # JS/CSS/画像を先に転送し、最後にトップページを更新。削除は行わない。
    Invoke-DashboardAws -Arguments @('s3', 'cp', $webRoot, $destination, '--recursive', '--exclude', 'index.html', '--exclude', '*.js', '--exclude', '*.css', '--cache-control', 'no-cache', '--only-show-errors') | Out-Host
    Invoke-DashboardAws -Arguments @('s3', 'cp', $webRoot, $destination, '--recursive', '--exclude', '*', '--include', '*.js', '--content-type', 'text/javascript', '--cache-control', 'no-cache', '--only-show-errors') | Out-Host
    Invoke-DashboardAws -Arguments @('s3', 'cp', $webRoot, $destination, '--recursive', '--exclude', '*', '--include', '*.css', '--content-type', 'text/css', '--cache-control', 'no-cache', '--only-show-errors') | Out-Host
    Invoke-DashboardAws -Arguments @('s3', 'cp', (Join-Path $webRoot 'index.html'), ($destination + 'index.html'), '--content-type', 'text/html', '--cache-control', 'no-cache', '--only-show-errors') | Out-Host
    $origin = ([Uri]$storage.DashboardUrl).GetLeftPart([UriPartial]::Authority)
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri ($backend.ApiBaseUrl + '/api/health') -Headers @{ Origin = $origin } -TimeoutSec 15
            $health = $response.Content | ConvertFrom-Json
            if ($health.status -ne 'ok' -or $health.deployment -ne 'aws' -or $health.dataMode -ne 'dynamodb') { throw 'API healthの内容が想定と異なります。' }
            if ([string]$response.Headers['Access-Control-Allow-Origin'] -ne $origin) { throw 'S3画面からのCORS応答が一致しません。' }
            break
        } catch { if ($attempt -eq 10) { throw }; Start-Sleep -Seconds 2 }
    }
    $page = Invoke-WebRequest -UseBasicParsing -Uri $storage.DashboardUrl -TimeoutSec 15
    if ($page.StatusCode -ne 200 -or [string]$page.Headers['Content-Type'] -notmatch '^text/html') { throw 'S3画面の応答を確認できません。' }
    $js = Invoke-WebRequest -UseBasicParsing -Uri ($storage.DashboardUrl -replace 'index.html$', 'app.js') -TimeoutSec 15
    if ([string]$js.Headers['Content-Type'] -notmatch '^(text|application)/(javascript|ecmascript)') { throw 'app.jsのContent-Typeを確認してください。' }
    $publishedConfig = Invoke-WebRequest -UseBasicParsing -Uri ($storage.DashboardUrl -replace 'index.html$', 'config.js') -TimeoutSec 15
    if (-not $publishedConfig.Content.Contains([string]$backend.ApiBaseUrl)) { throw '公開したconfig.jsのAPI URLが一致しません。' }
    $deliveriesResponse = Invoke-WebRequest -UseBasicParsing -Uri ($backend.ApiBaseUrl + '/api/deliveries') -TimeoutSec 15
    $deliveries = $deliveriesResponse.Content | ConvertFrom-Json
    $cellsResponse = Invoke-WebRequest -UseBasicParsing -Uri ($backend.ApiBaseUrl + '/api/cells') -TimeoutSec 15
    $cells = $cellsResponse.Content | ConvertFrom-Json
    if (-not $deliveries.PSObject.Properties['items'] -or -not $cells.PSObject.Properties['items']) { throw '一覧APIの応答形式が想定と異なります。' }
    $result = [ordered]@{
        AccountId = $identity.Account; Region = $Region; TableMode = $TableMode
        StorageStack = $storageStack; BackendStack = $backendStack
        DashboardUrl = $storage.DashboardUrl; ApiBaseUrl = $backend.ApiBaseUrl
        AnalysisTableName = $backend.AnalysisTableName; SummaryTableName = $backend.SummaryTableName; CellTableName = $backend.CellTableName
        DeliveryCount = @($deliveries.items).Count; CellCount = @($cells.items).Count
        CheckedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-Utf8File -Path (Join-Path $workRoot 'result.json') -Content (ConvertTo-Json -InputObject $result -Depth 5)
    Write-Host "Dの構築・配信・応答確認が完了しました。配送=$($result.DeliveryCount)、区画=$($result.CellCount)"
    Write-Host "Web URL: $($storage.DashboardUrl)"
    Write-Host "API URL: $($backend.ApiBaseUrl)"
    [pscustomobject]$result
} catch {
    Write-Host "Dの構築は完了していません。CloudFormationの $storageStack / $backendStack のイベントを確認してください。"
    Write-Host '認証期限、LabRole、S3公開ブロック、テーブル名を確認します。自動削除やアカウント全体の設定変更は行いません。'
    throw
}
