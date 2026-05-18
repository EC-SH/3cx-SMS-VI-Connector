#requires -version 5
<#
  deploy.ps1 — builds and deploys ONE role of the SMS connector to Cloud Run.
  One codebase, two services: same source, different role + secrets.

    ./deploy.ps1 -Role inbound
    ./deploy.ps1 -Role outbound

  Buildpacks build from source — no Dockerfile. Secrets must already exist in
  Secret Manager (see README "Secrets"); this script references them, it does
  not create them. If the post-deploy smoke test fails, traffic rolls back to
  the previous revision.
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('inbound', 'outbound')]
  [string]$Role,

  [string]$Region = 'us-central1',
  [string]$Project = (gcloud config get-value project 2>$null)
)

$ErrorActionPreference = 'Stop'
$service = "threecx-sms-$Role"

if (-not $Project) { throw "No GCP project set. Pass -Project or run 'gcloud config set project'." }

Write-Host "Deploying $service to $Region ($Project) — hold onto your butts"

# Capture the current live revision up front so a failed smoke test can roll back.
$prevRevision = gcloud run services describe $service `
  --region $Region --project $Project `
  --format 'value(status.latestReadyRevisionName)' 2>$null

# Role-specific config. Non-secret config via --set-env-vars; everything with
# any sensitivity (credentials, path secrets, the 3CX webhook URL) via
# --set-secrets so it never lands in plaintext deploy logs.
if ($Role -eq 'inbound') {
  $envVars = "SERVICE_ROLE=inbound"
  $secrets = "THREECX_WEBHOOK_URL=threecx-webhook-url:latest," +
             "INBOUND_PATH_SECRET=threecx-inbound-path-secret:latest"
}
else {
  $envVars = "SERVICE_ROLE=outbound"
  $secrets = "SANGOMA_API_KEY=sangoma-api-key:latest," +
             "SANGOMA_API_SECRET=sangoma-api-secret:latest," +
             "OUTBOUND_PATH_SECRET=threecx-outbound-path-secret:latest," +
             "OUTBOUND_SHARED_SECRET=threecx-outbound-shared-secret:latest"
}

# Both services face third-party webhooks on the public internet, so both need
# --allow-unauthenticated (3CX and Sangoma can't mint GCP identity tokens).
# Outbound is protected at the application layer: secret path + shared secret.
gcloud run deploy $service `
  --source . `
  --region $Region `
  --project $Project `
  --allow-unauthenticated `
  --set-env-vars $envVars `
  --set-secrets $secrets

if ($LASTEXITCODE -ne 0) { throw "Deploy failed for $service" }

# Smoke test: health check must answer 200 on the stable service URL.
$url = gcloud run services describe $service `
  --region $Region --project $Project `
  --format 'value(status.url)'

Write-Host "Smoke testing $url ..."
try {
  $resp = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 15 -UseBasicParsing
  if ($resp.StatusCode -ne 200) { throw "health check returned $($resp.StatusCode)" }
  Write-Host "Smoke test passed — $service is live at $url"
}
catch {
  Write-Host "Smoke test FAILED: $_"
  if ($prevRevision) {
    Write-Host "Rolling back to $prevRevision"
    gcloud run services update-traffic $service `
      --region $Region --project $Project `
      --to-revisions "$prevRevision=100"
  }
  else {
    Write-Host "No previous revision to roll back to — service may be down. Investigate."
  }
  throw "Deployment smoke test failed; rolled back."
}
