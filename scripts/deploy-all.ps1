#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$EnvFile = (Join-Path (Split-Path $PSScriptRoot -Parent) '.env'),
    [string]$Region,
    [ValidatePattern('^\d{12}$')][string]$ExpectedAccountId,
    [ValidatePattern('^[A-Za-z][A-Za-z0-9-]{0,99}$')][string]$IngestionStack = 'delivery-visualization-b',
    [ValidatePattern('^[A-Za-z][A-Za-z0-9-]{0,99}$')][string]$AnalysisStack = 'delivery-visualization-c',
    [ValidatePattern('^[A-Za-z][A-Za-z0-9-]{0,99}$')][string]$DashboardStack = 'delivery-visualization-d',
    [ValidatePattern('^[A-Za-z][A-Za-z0-9-]{0,99}$')][string]$CollectorStack = 'delivery-collector-s3',
    [ValidateSet('s3', 'cloudfront')][string]$CollectorHosting = 's3'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$stacks = @($IngestionStack, $AnalysisStack, "$DashboardStack-storage", "$DashboardStack-backend", $CollectorStack)
if (@($stacks | Select-Object -Unique).Count -ne $stacks.Count) { throw 'Stack names must be distinct.' }
if ($WhatIfPreference) {
    Write-Host "Preview: read root .env; verify AWS identity and local AWS CLI/SAM/Node.js/Python tools"
    Write-Host "Preview: $IngestionStack -> ingestion API, Lambda, measurement table with Streams"
    Write-Host "Preview: $AnalysisStack -> analysis Lambda, stream trigger, three result tables"
    Write-Host "Preview: $DashboardStack -> query Lambda/API and dashboard using C table outputs"
    Write-Host "Preview: $CollectorStack -> $CollectorHosting hosting, collector configured with B API output"
    Write-Host 'Preview: save URLs to .local/deploy-all/result.json; no AWS calls or local builds'
    return
}
foreach ($command in @('aws', 'sam', 'node', 'npm', 'python')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command is required before deployment." }
}
if (-not $Region) { $Region = & (Join-Path $PSScriptRoot 'read-deployment-region.ps1') -EnvFile $EnvFile }
$options = @{ EnvFile = $EnvFile; Region = $Region }
function Invoke-AllAws {
    param([string[]]$Arguments)
    & (Join-Path $PSScriptRoot 'aws-with-env.ps1') @options -Arguments $Arguments
}
function Read-Outputs {
    param([string]$Name, [string[]]$Required)
    $response = (Invoke-AllAws @('cloudformation', 'describe-stacks', '--stack-name', $Name, '--output', 'json')) -join "`n" | ConvertFrom-Json
    $values = @{}
    foreach ($item in $response.Stacks[0].Outputs) { $values[$item.OutputKey] = $item.OutputValue }
    foreach ($key in $Required) { if (-not $values[$key]) { throw "Missing output $key from $Name." } }
    $values
}
$identity = (Invoke-AllAws @('sts', 'get-caller-identity', '--output', 'json')) -join "`n" | ConvertFrom-Json
if ($ExpectedAccountId -and $identity.Account -ne $ExpectedAccountId) { throw 'AWS account mismatch.' }
$ExpectedAccountId = $identity.Account
if (-not $PSCmdlet.ShouldProcess("AWS account $ExpectedAccountId ($Region)", 'Deploy all system stacks and applications')) { return }
try {
    Write-Host '[1/4] Ingestion API / Lambda / measurement table'
    & (Join-Path $root 'infra/deploy.ps1') @options -StackName $IngestionStack
    $b = Read-Outputs $IngestionStack @('MeasurementApiUrl', 'MeasurementsStreamArn')

    Write-Host '[2/4] Analysis Lambda / Streams / result tables'
    & (Join-Path $PSScriptRoot 'deploy-sam.ps1') @options -TemplateFile (Join-Path $root 'infra/analysis.yaml') `
        -StackName $AnalysisStack -ParameterOverrides @("MeasurementsStreamArn=$($b.MeasurementsStreamArn)")
    $c = Read-Outputs $AnalysisStack @('AnalysisTableName', 'SummaryTableName', 'CellTableName')

    Write-Host '[3/4] Query API / Lambda / dashboard'
    $d = & (Join-Path $PSScriptRoot 'deploy-dashboard.ps1') @options -StackName $DashboardStack `
        -TableMode existing -AnalysisTableName $c.AnalysisTableName -SummaryTableName $c.SummaryTableName `
        -CellTableName $c.CellTableName -ExpectedAccountId $ExpectedAccountId

    Write-Host '[4/4] Collector infrastructure / application'
    $template = if ($CollectorHosting -eq 'cloudfront') { 'collector.yaml' } else { 'collector-s3.yaml' }
    Invoke-AllAws @('cloudformation', 'deploy', '--template-file', (Join-Path $root "infra/$template"),
        '--stack-name', $CollectorStack, '--no-fail-on-empty-changeset') | Out-Host
    $a = Read-Outputs $CollectorStack @('BucketName', 'CollectorUrl')
    $collectorOptions = @{ BucketName = $a.BucketName; MeasurementApiUrl = $b.MeasurementApiUrl; ExpectedAccountId = $ExpectedAccountId }
    if ($CollectorHosting -eq 'cloudfront') {
        if (-not $a.DistributionId) { throw 'Missing DistributionId.' }
        $collectorOptions.DistributionId = $a.DistributionId
    }
    & (Join-Path $PSScriptRoot 'deploy-collector.ps1') @options @collectorOptions
    $result = [ordered]@{
        AccountId = $ExpectedAccountId; Region = $Region; CollectorUrl = $a.CollectorUrl
        MeasurementApiUrl = $b.MeasurementApiUrl; DashboardUrl = $d.DashboardUrl; QueryApiUrl = $d.ApiBaseUrl
        IngestionStack = $IngestionStack; AnalysisStack = $AnalysisStack; DashboardStack = $DashboardStack; CollectorStack = $CollectorStack
        AnalysisTableName = $c.AnalysisTableName; SummaryTableName = $c.SummaryTableName; CellTableName = $c.CellTableName
    }
    $directory = Join-Path $root '.local/deploy-all'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $directory 'result.json'), ($result | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    [pscustomobject]$result
} catch {
    Write-Warning 'Deployment stopped. Completed stacks are retained. Inspect the failed stack events before retrying; no automatic deletion is performed.'
    throw
}
