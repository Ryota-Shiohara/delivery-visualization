$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }
if (-not $nodePath) {
  $runtimeRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes\cua_node'
  $nodePath = Get-ChildItem -LiteralPath $runtimeRoot -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $nodePath) { throw 'Node.js 20以上が見つかりません。Node.jsを用意してから再実行してください。' }
Set-Location -LiteralPath $repoRoot
Write-Host 'D担当のローカル仮環境を起動します。' -ForegroundColor Cyan
Write-Host 'ブラウザで http://127.0.0.1:4173 を開いてください。終了は Ctrl+C。'
& $nodePath (Join-Path $repoRoot 'scripts\local-dashboard-server.mjs')
