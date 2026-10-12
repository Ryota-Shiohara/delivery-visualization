#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$StackName = 'delivery-visualization-b',
    [string]$EnvFile = (Join-Path (Split-Path $PSScriptRoot -Parent) '.env'),
    [string]$Region
)
& (Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts/deploy-sam.ps1') `
    -TemplateFile (Join-Path $PSScriptRoot 'template.yaml') -StackName $StackName -EnvFile $EnvFile -Region $Region -WhatIf:$WhatIfPreference
