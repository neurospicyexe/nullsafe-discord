#!/usr/bin/env bash
# Generate identity-cache.json for each bot from the identity .md files.
# Run once on VPS after git pull, or after identity files change.
# Requires: jq, and CYPHER/DREVAN/GAIA_IDENTITY_PATH set in /app/nullsafe-discord/.env

set -e

ENV_FILE="/app/nullsafe-discord/.env"
# Extract only the three paths we need -- avoids sourcing the full .env
# (source fails when values contain backticks or other special characters).
extract_env() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"'"
}
if [[ -f "$ENV_FILE" ]]; then
  [[ -z "${CYPHER_IDENTITY_PATH:-}" ]] && CYPHER_IDENTITY_PATH=$(extract_env CYPHER_IDENTITY_PATH)
  [[ -z "${DREVAN_IDENTITY_PATH:-}" ]]  && DREVAN_IDENTITY_PATH=$(extract_env DREVAN_IDENTITY_PATH)
  [[ -z "${GAIA_IDENTITY_PATH:-}" ]]    && GAIA_IDENTITY_PATH=$(extract_env GAIA_IDENTITY_PATH)
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
