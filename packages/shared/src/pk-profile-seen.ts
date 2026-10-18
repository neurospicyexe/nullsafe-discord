/**
 * PK profile repeat guard (2026-10-18). The profile block rides the user message (hermesDelta
 * extras.frame), so the Hermes gateway stores it in the per-channel transcript for good: a member
 * chatting 20 turns left 20 copies of the same profile in history. Inject it once per member per
 * companion+channel per window instead; the speaker frame still names them on every turn.
 *
 * Key: ns:pkprofile:seen:<companion>:<channel>:<systemId>:<member>:<transcript id>. The transcript id
 * (hermesSessionIds sessionId: weekly/daily epoch plus the `:r<n>` retract bump) is part of the key,
 * so a rotated or retracted transcript, which has lost the profile, re-injects it on the next turn.
 * Fails open: no Redis or a Redis error returns "inject" (the old behaviour).
 */

export interface SeenRedis {
  set(key: string, val: string, ex: "EX", seconds: number, nx: "NX"): Promise<string | null>;
}

export interface PkSeenFacts {
  companion: string;
  channelId: string;
  systemId: string;
  member: string;
  /** The Hermes transcript id for this turn (epoch + retract bump). */
  sessionId: string;
}

const DEFAULT_REPEAT_S = 21600;

export function pkProfileRepeatS(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env["PK_PROFILE_REPEAT_S"] ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_REPEAT_S;
}

export function pkProfileSeenKey(f: PkSeenFacts): string {
  const who = f.member.trim().toLowerCase();
  return `ns:pkprofile:seen:${f.companion}:${f.channelId}:${f.systemId}:${who}:${f.sessionId}`;
}

export async function claimPkProfile(
  redis: SeenRedis | null,
  f: PkSeenFacts,
  ttlS: number = pkProfileRepeatS(),
): Promise<"inject" | "skip"> {
  if (!redis) return "inject";
  try {
    const r = await redis.set(pkProfileSeenKey(f), "1", "EX", ttlS, "NX");
    return r === "OK" ? "inject" : "skip";
  } catch {
    return "inject";
  }
}
