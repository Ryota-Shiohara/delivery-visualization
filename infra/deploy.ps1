Write-Host "=== Building AWS resources ==="

sam build -t template.yaml

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed."
    exit $LASTEXITCODE
}

Write-Host "=== Deploying to AWS ==="

sam deploy `
    --stack-name delivery-visualization-b `
    --region us-east-1 `
    --resolve-s3 `
    --no-confirm-changeset `
    --no-fail-on-empty-changeset

if ($LASTEXITCODE -ne 0) {
    Write-Host "Deploy failed."
    exit $LASTEXITCODE
}

Write-Host "=== Deployment complete ==="