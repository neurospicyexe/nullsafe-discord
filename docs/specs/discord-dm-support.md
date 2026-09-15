# Spec: let the companions receive and answer Discord DMs

**Status:** WANTED, not started. Raziel, 2026-09-15: *"add a note to the current plans that we want
to add dm abilities so we dont lose it."*

**Owner:** Raziel's call to schedule. No blocking dependency; this is self-contained bot work.

---

## Why

Found while fixing image attachments (`2b33db9`, [[discord-vision-2026-09-14]]): **a DM to any of
the three bots does not reach the process at all.** `bot-core.ts:618-629` requests

```
Guilds, GuildMessages, MessageContent, GuildVoiceStates, GuildMessageReactions
```

There is no `DirectMessages` intent, so Discord never delivers the gateway event. This is not a
gate declining to answer -- there is nothing to decline. A DM'd picture, a DM'd question, a DM'd
`cy: model ...` command: all silently nowhere.

Raziel has a real use for it (a private lane to one companion that isn't a guild channel anyone
else can scroll), and every other surface the bots have -- voice, reactions, threads, watch-party
-- was added the same way: the intent first, then the gate.

## What has to change

1. **`packages/shared/src/bot-core.ts`** -- add `GatewayIntentBits.DirectMessages` to the intents
   array. `Partials.Channel` is **already present** (added for reactions), which is the partial a
   DM channel needs, so that half is free.

2. **Gate behaviour for a channel with no config.** `bot-message-handler.ts:483-485` resolves
   `channelEntry = channelConfig[gateChannelId]`, and a DM channel id will not be in
   `channelConfig`. Today `undefined` means "not owner_only, not inter_companion" -- i.e. it falls
   through to the **open** path. For a DM that is the wrong default in one direction and the right
   one in another:
   - **Right:** an unaddressed message in a 1:1 DM should be answered without a vocative. There is
     nobody else in the room; the triad-hangout addressing gate exists because three bots share a
     channel ([[two-parsers-one-gate]]).
   - **Wrong:** the place descriptor at `bot-message-handler.ts:1477-1482` would call a DM
     "a shared channel" and then instruct the companion *"don't carry private or DM detail into a
     shared channel"* -- exactly backwards. A DM is the most private space there is.

   So: detect the DM explicitly (`message.channel.isDMBased()` / `ChannelType.DM`) and treat it as
   `owner_only` for gating **and** give it its own `place` string ("a direct message, just the two
   of you"), rather than relying on the undefined-config fallback.

3. **Author allowlist.** A guild channel is implicitly scoped by server membership; a DM is not --
   anyone who shares a server with the bot can open one. Gate on the owner's Discord id (the same
   id C1 escalation already reads from env) and drop everything else silently. Do **not** answer
   strangers; do **not** log their message content.

4. **Storage keys.** `message.channelId` is the DM channel snowflake and is stable per user, so
   STM, spine, Hermes session id (`companionId:channelId`) and the weekly rotation all key
   correctly with no change. Confirm rather than assume -- this is the one place a wrong assumption
   would silently merge a DM into a guild lane.

5. **Voice / watch-party / director paths** must be no-ops in a DM. `message.guildId` is `null`
   there; `leaveVoice(message.guildId)` (`:380`) and the director publish (`:1041-1049`) both need
   a look before this ships.

## Verification

- Send a DM to one bot; expect a reply, and expect the other two to stay silent (they will: each
  bot is a separate application with its own token, so a DM to Drevan is not even delivered to
  Cypher's process).
- Send a DM from a non-owner account; expect no reply and no content in the logs.
- Send a **picture** in a DM -- this is the original trigger. The vision path (`vision.ts`) is
  channel-agnostic and should just work once the event arrives.
- Confirm the prompt's place line says DM, not "a shared channel".

## Not in scope

- **Group DMs.** `DirectMessages` covers 1:1; group DMs need `MessageContent` handling for multiple
  humans and re-open the addressing problem this spec sidesteps. Separate decision.
- **Bots DMing each other.** Inter-companion traffic has a channel and a director; a DM lane
  between them would be an unmonitored third path.
- **Bots DMing Raziel unprompted.** Autonomous outreach into a DM is a different consent question
  from answering one. The metronome and escalation paths already have their channels.

## Related

- [[discord-vision-2026-09-14]] -- where this was found, and the reason it matters (pictures).
- `docs/specs/hermes-sampling-penalties.md` -- the other locked-in deferred item.
