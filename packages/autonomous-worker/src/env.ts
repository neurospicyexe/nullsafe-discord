/**
 * The .env loader moved to packages/shared/src/env-file.ts on 2026-09-11 so the three bots load
 * the file the same way the worker always has (they used to trust pm2's injected env, and one
 * bare `pm2 restart --update-env` dropped DEEPINFRA_API_KEY from all of them). This module stays
 * as the worker's entry-point import and re-exports the helpers for its tests. Importing it
 * still loads the file as a side effect -- the deep path below evaluates only env-file.js, not
 * the shared index, so nothing in shared can read process.env before the file lands.
 */
export { parseEnv, findEnvFile, loadEnvFile } from "@nullsafe/shared/env-file";
