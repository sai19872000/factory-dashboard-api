#!/usr/bin/env bash
# deploy.sh — wrangler deploy wrapper with CI safety assertions.
#
# Usage: ./scripts/deploy.sh [--env <env>] [other wrangler args...]
#
# Safety assertion: rejects any invocation that pairs --env production with
# a --var MOBILE_AUTH_MODE=* override (which would bypass auth in production).

set -euo pipefail

args=("$@")

# Detect --env production
env_is_production=false
for arg in "${args[@]}"; do
  if [[ "$arg" == "production" ]]; then
    env_is_production=true
  fi
done

# Detect any MOBILE_AUTH_MODE override in --var flags
has_auth_mode_override=false
for arg in "${args[@]}"; do
  if [[ "$arg" == *"MOBILE_AUTH_MODE"* ]]; then
    has_auth_mode_override=true
  fi
done

if $env_is_production && $has_auth_mode_override; then
  echo "ERROR: --env production cannot be paired with --var MOBILE_AUTH_MODE=*" >&2
  echo "       Production must always use the fail-closed oauth default." >&2
  exit 1
fi

exec npx wrangler deploy "${args[@]}"
