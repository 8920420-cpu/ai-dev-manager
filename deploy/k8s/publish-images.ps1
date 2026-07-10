# Publish local prod images to the LAN registry (step 5).
#
# Push goes through localhost:5000 (same registry container; 127.0.0.0/8 is
# always allowed as insecure), while cluster manifests reference it by the
# LAN address (PXE_SERVER_IP:5000) - the repository names are identical.
#
# Usage:
#   .\deploy\k8s\publish-images.ps1                     # push via localhost:5000, tag "prod"
#   .\deploy\k8s\publish-images.ps1 -PushRegistry 127.0.0.1:5000 -Tag prod
#
# Requires: images already built (docker compose build) and the registry up:
#   docker compose --env-file .env -f server/docker-compose.yml --profile registry up -d registry
param(
    [string]$PushRegistry = "localhost:5000",
    [string]$Tag = "prod"
)

$ErrorActionPreference = "Stop"

$images = @(
    "orchestrator-service",
    "tools-service",
    "mcp-service"
)

Write-Host "Publishing to $PushRegistry (tag: $Tag)"
foreach ($name in $images) {
    $src = "${name}:latest"
    $dst = "$PushRegistry/${name}:$Tag"
    Write-Host "  $src -> $dst"
    docker tag $src $dst
    if ($LASTEXITCODE -ne 0) { Write-Error "docker tag failed for $src (image not built?)" }
    docker push $dst
    if ($LASTEXITCODE -ne 0) { Write-Error "docker push failed for $dst (registry up?)" }
}
Write-Host "Done. Cluster pulls the same images as <PXE_SERVER_IP>:5000/<name>:$Tag (see kustomization.yaml)."
