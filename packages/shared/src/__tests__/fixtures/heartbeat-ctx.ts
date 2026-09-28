// A full AutonomousContext for driving the REAL runHeartbeat end to end (B7 steps 2 + 2c tests).
//
// Every Halseth call is a fake with prod-like DEAD gate inputs by default, taken from the 09-27
// audit: no palette row carries requires_signal (so detectSignals returns []), relational_need sits
// at 0.0026 against a 0.60 threshold and has not fired, and Raziel's last logged state is 40 hours
// old (the summary expires at 36h). The first inference call is the decision; the rest are lines.

import { jest } from "@jest/globals";
import type { AutonomousContext } from "../../autonomous-core.js";
import type { ReachLaneVerdict } from "../../librarian.js";
import { ALL_COMPANIONS } from "../../channel-config.js";

export const OPEN_LANE: ReachLaneVerdict = {
  local_date: "2026-09-28", quiet_window: null, quiet_presence_taken: false, gap_open: true,
  day_count: 0, daily_cap: 6, daily_cap_care_hold: 3, care_count: 0, care_ceiling: 2,
};

export interface Row { name: string; action_type: string; prompt?: string | null; requires_signal?: string | null }

export function row(action_type: string, name = action_type, prompt: string | null = null): Row {
  return { name, action_type, prompt };
}

/** Pin Date.now inside `companionId`'s 4-hour heartbeat window (the clock-derived rotation). */
export function inWindowOf(companionId: string): () => void {
  const W = 4 * 3_600_000;
  const idx = ALL_COMPANIONS.indexOf(companionId as never);
  const base = Math.floor(Date.now() / (3 * W)) * 3 * W;
  const t = base + idx * W + 60_000;
  const spy = jest.spyOn(Date, "now").mockReturnValue(t);
  return () => spy.mockRestore();
}

export function heartbeatCtx(opts: {
  companionId: string;
  palette: Row[];
  /** The decision the model returns: an action name from the palette. */
  choose: string;
  lines?: Array<string | null>;
  reach?: ReachLaneVerdict | null;
  drifts?: Array<{ id: string; drift_text: string; opened_at?: string; companion_id?: string }>;
  prefs?: number;
  noLane?: boolean;
}) {
  const lines = [...(opts.lines ?? [])];
  const prompts: string[] = [];
  const generate = jest.fn(async (_sys: string, msgs: Array<{ role: string; content: string }>) => {
    prompts.push(msgs.map(m => m.content).join("\n---\n"));
    if (prompts.length === 1) return JSON.stringify({ action: opts.choose, reason: "test" });
    return lines.shift() ?? null;
  });
  const actions = opts.palette.map((r, i) => ({
    id: `row${i}`, name: r.name, action_type: r.action_type, target: null, prompt: r.prompt ?? null,
    quiet_hours_allowed: r.action_type === "offer_presence" ? 1 : 0, status: "on" as const,
    requires_signal: r.requires_signal ?? null, signal_lookback_hours: null, last_fired_at: null, fire_count_today: 0,
  }));
  const dmSent: string[] = [];
  const channelSent: Array<{ channel: string; text: string }> = [];
  const librarian = {
    getEligibleMetronomePalette: jest.fn(async () => ({
      actions,
      quietHours: { active: false, in_force: false, local_hour: 10, tz: "America/Chicago" },
      reach: opts.reach === undefined ? OPEN_LANE : opts.reach,
    })),
    getState: jest.fn(async () => ({})),
    getRecentNotes: jest.fn(async () => []),
    getDrives: jest.fn(async () => [{ drive_key: "relational_need", level: 0.0026, threshold: 0.6, fired: false, modality: null }]),
    getRazielState: jest.fn(async () => ({ recorded_at: new Date(Date.now() - 40 * 3_600_000).toISOString(), mood: "ok", energy: 5 })),
    writeAutonomyRun: jest.fn(async () => "run1"),
    patchAutonomyRun: jest.fn(async () => undefined),
    recordMetronomeActionFired: jest.fn(async () => undefined),
    reachReserve: jest.fn(async () => ({ reserved: true as const, id: 11 })),
    reachRelease: jest.fn(async () => true),
    reachDelivered: jest.fn(async () => true),
    driftsOpen: jest.fn(async () => opts.drifts ?? []),
    getPreferences: jest.fn(async () => Array.from({ length: opts.prefs ?? 0 }, (_, i) => ({ id: `p${i}`, domain: "d", preference: "p", strength: "m", status: "active" }))),
    declarePreference: jest.fn(async () => ({ id: "pref1" })),
    postQuestion: jest.fn(async () => undefined),
    botOrient: jest.fn(async () => ({ open_questions: [] })),
    writeWmNote: jest.fn(async () => undefined),
    creaturesList: jest.fn(async () => [{ id: "sol", name: "Sol" }]),
    interactCreature: jest.fn(async () => undefined),
    ask: jest.fn(async () => ({ ack: true, id: "x" })),
  };
  const channel = {
    isTextBased: () => true,
    send: async (p: unknown) => {
      channelSent.push({ channel: "sol", text: typeof p === "string" ? p : String((p as { content?: string }).content ?? p) });
      return { id: `c${channelSent.length}` };
    },
  };
  const target = {
    channelId: "dm-owner",
    send: async (t: string) => { dmSent.push(t); return `d${dmSent.length}`; },
    recentOwnTexts: async () => [],
  };
  const onSent = jest.fn(async () => undefined);
  const ctx = {
    companionId: opts.companionId,
    cooldownMs: 60_000,
    floorLockMs: 60_000,
    heartbeatChannelId: "sol",
    interCompanionChannelId: undefined,
    interestKeywords: [],
    defaultInterTarget: "cypher",
    halsethSecret: "s",
    prompts: {
      postHeartbeat: "heartbeat", checkInOnRaziel: "check in", askQuestion: "ask", offerPresence: "presence",
      sendReminder: "remind", shareObservation: "share", namePattern: "pattern", writeJournal: "j", writeFeeling: "f",
      writeNoteToRaziel: "n", writeInterCompanion: () => "w",
    },
    librarian,
    inference: { generate },
    client: { user: { id: "bot" }, channels: { fetch: jest.fn(async () => channel) } },
    configCache: {},
    bootCtx: { systemPrompt: "SYS" },
    sessionWindows: { isAnyActive: () => false },
    redis: null,
    cooldown: new Map<string, number>(),
    messageBuffer: [],
    cycleGuard: { check: () => "ok", reset: () => {} },
    registerSentId: () => {},
    ownerDm: opts.noLane ? undefined : { resolve: async () => target, onSent },
  } as unknown as AutonomousContext;
  return { ctx, librarian, generate, prompts, dmSent, channelSent, onSent };
}
