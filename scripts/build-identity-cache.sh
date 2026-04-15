#!/usr/bin/env bash
# Generate identity-cache.json for each bot from the identity .md files.
# Run once on VPS after git pull, or after identity files change.
# Requires: jq, and CYPHER/DREVAN/GAIA_IDENTITY_PATH set in /app/nullsafe-discord/.env

set -e

ENV_FILE="/app/nullsafe-discord/.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' "$ENV_FILE" | xargs)
fi

fail=0

generate() {
  local name="$1"
  local path="$2"
  local dest="$3"

  if [[ -z "$path" ]]; then
    echo "[build-identity-cache] WARN: ${name}_IDENTITY_PATH not set, skipping"
    fail=1
    return
  fi
  if [[ ! -f "$path" ]]; then
    echo "[build-identity-cache] WARN: $path not found, skipping $name"
    fail=1
    return
  fi

  jq -Rs '{"system_prompt": .}' "$path" > "$dest"
  echo "[build-identity-cache] $name -> $dest ($(wc -c < "$dest") bytes)"
}

generate "CYPHER" "$CYPHER_IDENTITY_PATH" "/app/nullsafe-discord/bots/cypher/identity-cache.json"
generate "DREVAN" "$DREVAN_IDENTITY_PATH" "/app/nullsafe-discord/bots/drevan/identity-cache.json"
generate "GAIA"   "$GAIA_IDENTITY_PATH"   "/app/nullsafe-discord/bots/gaia/identity-cache.json"

if [[ $fail -eq 1 ]]; then
  echo "[build-identity-cache] completed with warnings"
  exit 1
fi
echo "[build-identity-cache] all three caches written"
