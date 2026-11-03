import { describe, it, expect, vi } from "vitest";
import { decideProbe, runLiveSyncProbe, EMPTY_STATE, composeFlagText, type LiveSyncDeps, type LiveSyncState } from "../livesync-watch.js";

const H = 3_600_000;
const t = { staleHours: 3, staleOffHours: 24 };
const NOW = 1_800_000_000_000;

describe("decideProbe", () => {
  it("fresh, no flag", () => {
    expect(decideProbe({ ageMs: 1 * H, pcOn: true, now: NOW, state: EMPTY_STATE, t })).toEqual({ action: "fresh", clearFlag: false });
  });
  it("fresh clears a live flag", () => {
    const s: LiveSyncState = { flagRaisedAt: NOW - H, flagKind: "stalled" };
    expect(decideProbe({ ageMs: H, pcOn: true, now: NOW, state: s, t })).toEqual({ action: "fresh", clearFlag: true });
  });
  it("stale + PC on nudges first", () => {
    expect(decideProbe({ ageMs: 5 * H, pcOn: true, now: NOW, state: EMPTY_STATE, t }).action).toBe("nudge");
  });
  it("still stale after nudge flags stalled", () => {
    expect(decideProbe({ ageMs: 5 * H, pcOn: true, nudged: true, now: NOW, state: EMPTY_STATE, t }))
      .toEqual({ action: "flag", kind: "stalled", repeat: false });
  });
  it("flag raised <24h ago is a repeat; >24h is not", () => {
    const recent: LiveSyncState = { flagRaisedAt: NOW - 5 * H, flagKind: "stalled" };
    const old: LiveSyncState = { flagRaisedAt: NOW - 25 * H, flagKind: "stalled" };
    expect(decideProbe({ ageMs: 9 * H, pcOn: true, nudged: true, now: NOW, state: recent, t })).toMatchObject({ repeat: true });
    expect(decideProbe({ ageMs: 9 * H, pcOn: true, nudged: true, now: NOW, state: old, t })).toMatchObject({ repeat: false });
  });
  it("PC off: no alarm within the grace, flag beyond it", () => {
    expect(decideProbe({ ageMs: 10 * H, pcOn: false, now: NOW, state: EMPTY_STATE, t }).action).toBe("wait");
    expect(decideProbe({ ageMs: 30 * H, pcOn: false, now: NOW, state: EMPTY_STATE, t }))
      .toEqual({ action: "flag", kind: "pc_off", repeat: false });
  });
});

function deps(over: Partial<LiveSyncDeps> & { mtimes: number[] }): LiveSyncDeps & { cmds: string[]; notes: string[]; saved: LiveSyncState[] } {
  const cmds: string[] = []; const notes: string[] = []; const saved: LiveSyncState[] = [];
  const q = [...over.mtimes];
  return {
    cfg: null,
    newest: async () => (q.length > 1 ? q.shift()! : q[0]!),
    restPing: async () => true,
    restCommand: async (id: string) => { cmds.push(id); return true; },
    sleep: async () => {},
    notify: async (x: string) => { notes.push(x); return true; },
    now: () => NOW,
    state: { ...EMPTY_STATE },
    saveState: (s: LiveSyncState) => { saved.push(s); },
    t, nudgeWaitMs: 0,
    ...over, cmds, notes, saved,
  } as never;
}

describe("runLiveSyncProbe", () => {
  it("fresh does nothing", async () => {
    const d = deps({ mtimes: [NOW - H] });
    expect(await runLiveSyncProbe(d)).toBe("fresh");
    expect(d.cmds).toEqual([]); expect(d.notes).toEqual([]);
  });
  it("stale then healed by the nudge: no flag", async () => {
    const d = deps({ mtimes: [NOW - 6 * H, NOW - 1000] });
    expect(await runLiveSyncProbe(d)).toBe("healed");
    expect(d.cmds).toEqual(["obsidian-livesync:livesync-replicate"]); expect(d.notes).toEqual([]);
  });
  it("stale, nudge fails: flags, opens the pause dialog once, stamps state", async () => {
    const d = deps({ mtimes: [NOW - 6 * H] });
    expect(await runLiveSyncProbe(d)).toBe("flagged_stalled");
    expect(d.cmds).toEqual(["obsidian-livesync:livesync-replicate", "obsidian-livesync:livesync-review-compatibility-pause"]);
    expect(d.notes[0]).toContain("stuck:livesync"); expect(d.saved[0]?.flagRaisedAt).toBe(NOW);
  });
  it("second tick the same day: nudges but does not re-flag or re-open the dialog", async () => {
    const d = deps({ mtimes: [NOW - 8 * H], state: { flagRaisedAt: NOW - H, flagKind: "stalled" } });
    expect(await runLiveSyncProbe(d)).toBe("flag_suppressed");
    expect(d.cmds).toEqual(["obsidian-livesync:livesync-replicate"]); expect(d.notes).toEqual([]);
  });
  it("a failed Discord send does not burn the once-a-day slot", async () => {
    const d = deps({ mtimes: [NOW - 6 * H], notify: async () => false });
    await runLiveSyncProbe(d);
    expect(d.saved).toEqual([]);
  });
  it("PC off, stale 10h: silent", async () => {
    const d = deps({ mtimes: [NOW - 10 * H], restPing: async () => false });
    expect(await runLiveSyncProbe(d)).toBe("waiting_pc_off");
    expect(d.cmds).toEqual([]); expect(d.notes).toEqual([]);
  });
  it("PC off, stale 30h: flags without nudging or the dialog", async () => {
    const d = deps({ mtimes: [NOW - 30 * H], restPing: async () => false });
    expect(await runLiveSyncProbe(d)).toBe("flagged_pc_off");
    expect(d.cmds).toEqual([]); expect(d.notes[0]).toContain("PC seems off");
  });
  it("fresh again clears the flag and says so", async () => {
    const d = deps({ mtimes: [NOW - H], state: { flagRaisedAt: NOW - 5 * H, flagKind: "stalled" } });
    expect(await runLiveSyncProbe(d)).toBe("recovered");
    expect(d.saved[0]).toEqual(EMPTY_STATE); expect(d.notes[0]).toContain("cleared");
  });
  it("unreadable CouchDB does nothing", async () => {
    const d = deps({ mtimes: [] as number[], newest: async () => null });
    expect(await runLiveSyncProbe(d)).toBe("unreadable");
  });
});

describe("composeFlagText", () => {
  it("names the stop time and leaks nothing else", () => {
    const x = composeFlagText("stalled", NOW - 6 * H, 6 * H);
    expect(x).toContain("stopped syncing at"); expect(x).toContain("approve the sync window");
  });
});
