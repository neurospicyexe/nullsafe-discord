// director-invite.ts -- the bot's half of the Conversation Director (spec 2026-09-03). The director
// says who and what; this file says HOW, in the companion's own voice, and reports back. Passing is
// a legal move and is reported as one.
import type { TextChannel } from "discord.js";
import {
  publishDirectorResult, onDirectorInvite,
  type DirectorInvitePayload, type CommonsMessagePayload,
} from "./events.js";
import { generateOutward } from "./outward.js";
import { parseLandMarker } from "./thread-spine.js";
import { ownEchoGated } from "./echo-guard.js";
import { sendAutonomousMessage, type AutonomousContext } from "./autonomous-core.js";
import type { CompanionId } from "./types.js";

const PASS_RE = /^\s*\[?PASS\]?(\s|$)/i;
export function isPass(text: string): boolean { return PASS_RE.test(text); }

function renderOffer(invite: DirectorInvitePayload): string {
  return invite.offer.map((o) => `- [${o.kind}] ${o.title}${o.body ? ` -- ${o.body.slice(0, 300)}` : ""}`).join("\n");
}

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function usedOffers(text: string, invite: DirectorInvitePayload): string[] {
  const t = text.toLowerCase();
  return invite.offer.filter((o) => {
    const words = o.title.toLowerCase().split(/\W+/).filter((w) => w.length >= 5);
    return words.length > 0 && words.filter((w) => new RegExp(`\\b${escapeRegExp(w)}\\b`).test(t)).length >= Math.min(2, words.length);
  }).map((o) => o.id);
}

/**
 * Pure translation from a raw Discord message + this handler's local flags into the payload
 * published to the commons bus. Extracted from bot-message-handler.ts (2026-09-03 review, finding
 * 2) so the routing decision itself is unit-testable without a real discord.js Message.
 */
export function commonsMessageFor(input: {
  channelId: string; messageId: string; authorId: string; isCompanionBot: boolean;
  webhookId: string | null | undefined; senderCompanion: CompanionId | undefined;
  content: string; replyToMessageId: string | null; createdTimestamp: number; publishedBy: CompanionId;
}): CommonsMessagePayload {
  return {
    channelId: input.channelId, messageId: input.messageId, authorId: input.authorId,
    authorKind: input.isCompanionBot ? "companion" : (input.webhookId ? "proxy" : "human"),
    companionId: input.isCompanionBot ? input.senderCompanion : undefined,
    content: input.content, replyToMessageId: input.replyToMessageId,
    createdAt: new Date(input.createdTimestamp).toISOString(), publishedBy: input.publishedBy,
  };
}

/**
 * Whether THIS bot must stand down and let the director route the reply instead of self-selecting
 * one. True only for a companion turn while the director is fully live -- a human turn always falls
 * through unchanged, and shadow mode publishes to the bus without ever suppressing a bot's own path.
 */
export function shouldDeferToDirector(input: { isCompanionBot: boolean; mode: "off" | "shadow" | "live" }): boolean {
  return input.isCompanionBot && input.mode === "live";
}

export async function handleDirectorInvite(ctx: AutonomousContext, invite: DirectorInvitePayload, deps: { now?: () => number } = {}): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const report = (outcome: "spoke" | "passed" | "empty" | "expired", extra: { messageId?: string; landed?: string | null; usedOfferIds?: string[] } = {}) =>
    ctx.redis ? publishDirectorResult(ctx.redis, { inviteId: invite.inviteId, companionId: ctx.companionId, channelId: invite.channelId, outcome, usedOfferIds: extra.usedOfferIds ?? [], messageId: extra.messageId, landed: extra.landed ?? null }) : Promise.resolve();

  if (Date.parse(invite.expiresAt) < now()) { console.warn(`[${ctx.companionId}/director] invite ${invite.inviteId} expired -- dropping`); await report("expired"); return; }

  const prompt = ctx.prompts.directorInvite({ stateBlock: invite.stateBlock, offerBlock: renderOffer(invite), reason: invite.reason, addressedBy: invite.addressedBy, neighborhoodBlock: invite.neighborhoodBlock });
  const raw = await generateOutward(ctx.inference, ctx.bootCtx.systemPrompt, prompt, ctx.companionId, "director");
  if (!raw || !raw.trim()) { await report("empty"); return; }
  if (isPass(raw)) { console.log(`[${ctx.companionId}/director] passed on ${invite.reason} invite`); await report("passed"); return; }

  const land = parseLandMarker(raw);
  const text = land.cleaned.trim();
  if (!text) { await report("empty"); return; }

  // Own-echo gate against this bot's recent turns in the channel (uniform for all three).
  let own: string[] = [];
  try {
    const chan = await ctx.client.channels.fetch(invite.channelId);
    if (chan?.isTextBased()) {
      const recent = await (chan as TextChannel).messages.fetch({ limit: 15 });
      const selfId = ctx.client.user?.id;
      own = selfId ? [...recent.values()].filter((m) => m.author.id === selfId).map((m) => m.content.slice(0, 2000)) : [];
    }
  } catch { /* no pool, no gate */ }
  const echo = ownEchoGated(ctx.companionId, text, own);
  if (echo.gated) { console.warn(`[${ctx.companionId}/director] own-echo-gated (score=${echo.score.toFixed(2)}) -- reporting empty`); await report("empty"); return; }

  let sentId: string | undefined;
  await sendAutonomousMessage(ctx, invite.channelId, text, "director", { onSent: (id) => { sentId ??= id; } });
  const used = usedOffers(text, invite);
  await report("spoke", { messageId: sentId, landed: land.resolution, usedOfferIds: used });
  // Consume-on-use for the kinds whose stamp lives bot-side (post already landed above). Forage is
  // consumed by the director on the result; questions and sibling notes have bot-side clients.
  for (const o of invite.offer.filter((x) => used.includes(x.id))) {
    if (o.kind === "question") await ctx.librarian.markQuestionVoiced(o.id).catch(() => false);
    if (o.kind === "sibling_note") await ctx.librarian.commonsConsume([o.id], invite.channelId).catch(() => {});
  }
}

/**
 * Subscribe this bot to its own invite channel. Uses a duplicate of the command client as the
 * subscriber. Invites are chained onto one promise so a bot never runs two `handleDirectorInvite`
 * calls concurrently -- without this, two invites arriving close together could each swap in their
 * own sent-id capture (now moot after the `onSent` fix) and, more importantly, could interleave
 * echo-gate reads/writes and floor use in ways the single-companion model never has to reason about.
 */
export function startDirectorListener(ctx: AutonomousContext): () => void {
  if (!ctx.redis) { console.warn(`[${ctx.companionId}/director] no redis -- listener not started`); return () => {}; }
  const sub = ctx.redis.duplicate();
  let chain: Promise<void> = Promise.resolve();
  const off = onDirectorInvite(sub, ctx.companionId, (invite) => {
    chain = chain
      .then(() => handleDirectorInvite(ctx, invite))
      .catch((e) => console.error(`[${ctx.companionId}/director] invite failed:`, e));
  });
  console.log(`[${ctx.companionId}/director] listening for invitations`);
  return () => { off(); sub.quit().catch(() => {}); };
}
