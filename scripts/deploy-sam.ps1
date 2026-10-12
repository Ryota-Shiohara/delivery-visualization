#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$TemplateFile,
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z][A-Za-z0-9-]{0,99}$')][string]$StackName,
    [string]$EnvFile = (Join-Path (Split-Path $PSScriptRoot -Parent) '.env'),
    [string]$Region,
    [string[]]$ParameterOverrides = @()
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($WhatIfPreference) { Write-Host "Preview: SAM build $TemplateFile -> deploy $StackName using .env"; return }
if (-not $Region) { $Region = & (Join-Path $PSScriptRoot 'read-deployment-region.ps1') -EnvFile $EnvFile }
foreach ($command in @('sam', 'aws')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command is required." }
}
if (-not $PSCmdlet.ShouldProcess($StackName, 'Build and deploy SAM stack')) { return }
$buildDir = Join-Path (Split-Path $PSScriptRoot -Parent) ".local/sam/$StackName"
& sam build --template-file (Resolve-Path -LiteralPath $TemplateFile).Path --build-dir $buildDir | Out-Host
if ($LASTEXITCODE -ne 0) { throw "SAM build failed ($LASTEXITCODE)." }
$arguments = @('deploy', '--template-file', (Join-Path $buildDir 'template.yaml'), '--stack-name', $StackName,
    '--resolve-s3', '--no-confirm-changeset', '--no-fail-on-empty-changeset')
if ($ParameterOverrides.Count) { $arguments += @('--parameter-overrides') + $ParameterOverrides }
Write-Host "Deploying SAM stack: $StackName ($Region)"
& (Join-Path $PSScriptRoot 'aws-with-env.ps1') -Executable sam -EnvFile $EnvFile -Region $Region -Arguments $arguments | Out-Host
