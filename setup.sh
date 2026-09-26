#!/usr/bin/env bash
# One-shot setup for the AutoMorpheBuilder UI auth handler.
#
# What this does:
#   1. Authenticates you with Cloudflare (opens a browser the first time)
#   2. Sets the four required secrets (client_id, client_secret, app_slug, allowed_origin)
#   3. Deploys the worker
#
# Prerequisites:
#   - A Cloudflare account (free tier works)
#   - The wrangler CLI installed (`npm install` in this directory)
#
# Prerequisites (one-time, in your Cloudflare account):
#   1. Visit https://dash.cloudflare.com/<account-id>/workers/onboarding
#      and set up a workers.dev subdomain. Pick any prefix (e.g. "nxn94").
#      This is required before ANY worker can deploy.
#   2. Create an API token at https://dash.cloudflare.com/profile/api-tokens
#      with the "Edit Cloudflare Workers" template, scoped to your account.
#   3. Add the token as a repository secret named CLOUDFLARE_API_TOKEN
#      (Settings → Secrets and variables → Actions → New repository secret).
#   4. Set the worker secrets via the Cloudflare dashboard or by running
#      `wrangler secret put <NAME>` from a machine with wrangler CLI logged in.
#      Required secrets:
#        GITHUB_APP_CLIENT_ID
#        GITHUB_APP_CLIENT_SECRET
#        APP_SLUG
#
# The GitHub App registration must have a callback URL matching the deployed
# worker's URL + /callback. See ../README.md for the full flow.

set -euo pipefail

cd "$(dirname "$0")"

# Pull secrets from local files written by the operator (NOT committed).
SECRETS_DIR="${AMB_SECRETS_DIR:-../secrets}"
CLIENT_ID="$(cat "$SECRETS_DIR/client-id")"
CLIENT_SECRET="$(cat "$SECRETS_DIR/client-secret")"
APP_SLUG="$(cat "$SECRETS_DIR/app-slug")"

echo "▸ Logging in to Cloudflare (browser will open)..."
npx wrangler login

echo "▸ Setting secrets..."
printf '%s' "$CLIENT_ID"     | npx wrangler secret put GITHUB_APP_CLIENT_ID
printf '%s' "$CLIENT_SECRET" | npx wrangler secret put GITHUB_APP_CLIENT_SECRET
printf '%s' "$APP_SLUG"      | npx wrangler secret put APP_SLUG

echo "▸ Deploying..."
npx wrangler deploy

echo ""
echo "Done! Note the deployed URL. Update:"
echo "  1. GitHub App → Callback URL: <url>/callback"
echo "  2. AutoMorpheBuilder-UI/assets/auth.js DEFAULT_AUTH_BASE (if not amb-ui-auth.<subdomain>.workers.dev)"
echo "  3. wrangler.jsonc ALLOWED_ORIGIN (must match the UI Pages URL)"