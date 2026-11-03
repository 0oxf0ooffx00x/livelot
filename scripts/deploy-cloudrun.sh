#!/usr/bin/env bash
# Deploy LiveLot to Cloud Run as ONE always-on instance (stock lives in memory; never scale past 1).
# Usage: scripts/deploy-cloudrun.sh [project] [region]
# Don't run this during a live show: a new revision restarts the server and drops unpaid holds.
# The first deploy is private. Making it public (buyers, webhooks, OBS need that) is a separate,
# one-time step, and redeploys keep whatever access you set:
#   gcloud run services add-iam-policy-binding livelot --project livelot-hackathon \
#     --region europe-west2 --member=allUsers --role=roles/run.invoker
set -euo pipefail
PROJECT="${1:-${GCP_PROJECT:-livelot-hackathon}}"
REGION="${2:-${GCP_REGION:-europe-west2}}"
ENV_FILE="deploy/cloudrun.env.yaml"
# Settings saved in the dashboard's Settings screen live in this private bucket, mounted at /settings,
# so they survive restarts and deploys. Create it once:
#   gcloud storage buckets create gs://$PROJECT-settings --location $REGION --uniform-bucket-level-access --public-access-prevention
SETTINGS_BUCKET="${SETTINGS_BUCKET:-$PROJECT-settings}"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE (copy deploy/cloudrun.env.example.yaml)"; exit 1; }

gcloud run deploy livelot \
  --project "$PROJECT" --region "$REGION" \
  --source . --quiet \
  --set-build-env-vars GOOGLE_RUNTIME=nodejs \
  --min-instances 1 --max-instances 1 \
  --no-cpu-throttling \
  --cpu 1 --memory 1Gi \
  --concurrency 250 \
  --timeout 3600 \
  --execution-environment gen2 \
  --clear-volumes --add-volume "name=settings,type=cloud-storage,bucket=$SETTINGS_BUCKET" \
  --clear-volume-mounts --add-volume-mount "volume=settings,mount-path=/settings" \
  --env-vars-file "$ENV_FILE"

gcloud run services describe livelot --project "$PROJECT" --region "$REGION" --format='value(status.url)'
