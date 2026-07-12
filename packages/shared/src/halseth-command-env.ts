// halseth-command-env.ts -- single shared halsethEnv() used by every owner-gated
// Discord command module (club, creatures, into, log, tools, media). Previously
// five copies of this function each re-derived HALSETH_SECRET ?? ADMIN_SECRET
// straight from process.env, bypassing the per-companion secret each bot's own
// config.ts already resolves at boot into BotConfig.halsethSecret. This version
// takes that resolved secret as a parameter instead -- one source of truth
// (the bot's own config), not two competing resolution paths (2026-07-12).

export function halsethEnv(secret: string): { base: string; secret: string } | null {
  const base = process.env["HALSETH_URL"];
  if (!base || !secret) {
    console.error("[halseth-command-env] HALSETH_URL missing or no companion secret provided");
    return null;
  }
  return { base: base.replace(/\/$/, ""), secret };
}
