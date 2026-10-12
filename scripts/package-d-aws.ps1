[CmdletBinding()]
param([string]$NodePath)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodePath) { $NodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null } }
if (-not $nodePath) {
  $runtimeRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes\cua_node'
  $nodePath = Get-ChildItem -LiteralPath $runtimeRoot -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $nodePath) { throw 'Node.js 20以上が必要です。' }
& $nodePath (Join-Path $PSScriptRoot 'prepare-d-aws.mjs')
if ($LASTEXITCODE -ne 0) { throw 'AWS用のファイル準備に失敗しました。' }
$destination = Join-Path $repoRoot '.local\artifacts'
$lambdaFiles = @('index.mjs', 'aws-handler-core.mjs', 'local-contract.mjs', 'demo.json', 'c-shared-example.json') | ForEach-Object { Join-Path (Join-Path $repoRoot '.local\aws-build\lambda') $_ }
Compress-Archive -LiteralPath $lambdaFiles -DestinationPath (Join-Path $destination 'D担当_AWS参照Lambda.zip') -Force
Compress-Archive -LiteralPath (Join-Path $repoRoot '.local\aws-build\web\dashboard') -DestinationPath (Join-Path $destination 'D担当_S3画面.zip') -Force
Write-Host 'Lambda用ZIPとS3画面用ZIPを出力しました。AWSにはアップロードしていません。'
