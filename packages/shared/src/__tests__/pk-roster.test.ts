import { jest, describe, it, expect } from "@jest/globals";
import { PkRoster, pkSystemsFromEnv } from "../pk-roster.js";
import { resolveAttribution } from "../pluralkit.js";

const OWNER = "owner-1";
const BLUE = "blue-1";
const OWNER_SYS = "abcdef";
const BLUE_SYS = "szplj";

const SYSTEMS = [
  { systemId: OWNER_SYS, discordUserId: OWNER, isOwner: true },
  { systemId: BLUE_SYS, discordUserId: BLUE, isOwner: false },
];

function memberApi(bySystem: Record<string, Array<{ name?: string; display_name?: string }>>): typeof fetch {
  return jest.fn().mockImplementation(async (url: unknown) => {
    const sys = String(url).match(/systems\/([^/]+)\/members/)?.[1] ?? "";
    const rows = bySystem[sys];
    if (!rows) return { ok: false, status: 403 };
    return { ok: true, json: async () => rows };
  }) as unknown as typeof fetch;
}

async function loadedRoster(): Promise<PkRoster> {
  const r = new PkRoster(SYSTEMS, memberApi({
    [OWNER_SYS]: [
      { name: "ashwood", display_name: "Ash" },
      { name: "Vel" },
      { name: "shared-name" },
    ],
    [BLUE_SYS]: [
      { name: "Tide", display_name: "Tide" },
      { name: "shared-name" },
    ],
  }));
  await r.ensureLoaded();
  return r;
}

describe("PkRoster.identify()", () => {
  it("resolves the display name PluralKit puts on the webhook", async () => {
    const r = await loadedRoster();
    expect(r.identify("Ash")).toMatchObject({ memberName: "Ash", isOwner: true, discordUserId: OWNER });
  });

  it("resolves the raw member name too (member with no display name)", async () => {
    const r = await loadedRoster();
    expect(r.identify("Vel")).toMatchObject({ isOwner: true, discordUserId: OWNER });
  });

  it("still resolves the underlying name when a display name exists", async () => {
    const r = await loadedRoster();
    expect(r.identify("ashwood")).toMatchObject({ memberName: "Ash", isOwner: true });
  });

  it("is case- and whitespace-insensitive", async () => {
    const r = await loadedRoster();
    expect(r.identify("  ASH  ")).toMatchObject({ isOwner: true });
  });

  it("absorbs an appended system tag", async () => {
    const r = await loadedRoster();
    expect(r.identify("Ash | Nullsafe")).toMatchObject({ memberName: "Ash", isOwner: true });
  });

  it("Blue's member resolves to Blue, never to owner", async () => {
    const r = await loadedRoster();
    expect(r.identify("Tide")).toMatchObject({ isOwner: false, discordUserId: BLUE });
  });

  it("a name registered in BOTH systems is refused rather than guessed", async () => {
    // Guessing here would hand one system's tier to the other's member.
    const r = await loadedRoster();
    expect(r.identify("shared-name")).toBeNull();
  });

  it("unknown name and empty input return null", async () => {
    const r = await loadedRoster();
    expect(r.identify("SomeGuest")).toBeNull();
    expect(r.identify("")).toBeNull();
    expect(r.identify(null)).toBeNull();
  });

  it("a private member list (403) leaves the roster empty rather than throwing", async () => {
    const r = new PkRoster(SYSTEMS, memberApi({}));
    await r.ensureLoaded();
    expect(r.loaded).toBe(false);
    expect(r.identify("Ash")).toBeNull();
  });

  it("a failed refresh keeps the previously loaded roster instead of blanking it", async () => {
    const r = await loadedRoster();
    const before = r.size;
    const dead = new PkRoster(SYSTEMS, (() => { throw new Error("network down"); }) as unknown as typeof fetch);
    await dead.ensureLoaded(); // separate instance: proves failure is survivable
    expect(dead.loaded).toBe(false);
    expect(r.size).toBe(before);
  });

  it("uses the shared cache when present and does not hit the API", async () => {
    const seeded = await loadedRoster();
    const store = new Map<string, string>();
    const cache = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => { store.set(k, v); return "OK"; },
    };
    const writer = new PkRoster(SYSTEMS, memberApi({
      [OWNER_SYS]: [{ name: "ashwood", display_name: "Ash" }],
    }), cache);
    await writer.ensureLoaded();
    expect(writer.loaded).toBe(true);

    const apiThatMustNotRun = jest.fn(async () => { throw new Error("API must not be called"); });
    const reader = new PkRoster(SYSTEMS, apiThatMustNotRun as unknown as typeof fetch, cache);
    await reader.ensureLoaded();
    expect(reader.identify("Ash")).toMatchObject({ isOwner: true });
    expect(apiThatMustNotRun).not.toHaveBeenCalled();
    expect(seeded.loaded).toBe(true);
  });
});

describe("pkSystemsFromEnv()", () => {
  it("drops systems with no id, keeps the owner system", () => {
    expect(pkSystemsFromEnv({ ownerSystemId: OWNER_SYS, ownerDiscordId: OWNER })).toEqual([
      { systemId: OWNER_SYS, discordUserId: OWNER, isOwner: true },
    ]);
  });

  it("requires both id and discord id for Blue", () => {
    expect(pkSystemsFromEnv({ ownerSystemId: OWNER_SYS, ownerDiscordId: OWNER, blueSystemId: BLUE_SYS })).toHaveLength(1);
    expect(pkSystemsFromEnv({ ownerSystemId: OWNER_SYS, ownerDiscordId: OWNER, blueSystemId: BLUE_SYS, blueDiscordId: BLUE })).toHaveLength(2);
  });

  it("no PK system configured at all -> empty (roster disabled, API path unchanged)", () => {
    expect(pkSystemsFromEnv({ ownerDiscordId: OWNER })).toEqual([]);
  });
});

describe("resolveAttribution() with a roster", () => {
  const proxied = (username: string) =>
    ({ webhookId: "wh1", author: { id: "wh1", bot: true, username }, id: "m1" }) as never;

  const deadApi = jest.fn(async () => { throw new Error("PK API down"); }) as unknown as typeof fetch;

  it("owner's front resolves with the PK API completely down -- this is the timeout fix", async () => {
    const r = await loadedRoster();
    const got = await resolveAttribution(proxied("Ash"), OWNER, undefined, deadApi, BLUE, BLUE_SYS, r);
    expect(got).toMatchObject({
      isOwner: true, discordUserId: OWNER, frontMember: "Ash", frontState: "known", source: "pluralkit",
    });
  });

  it("does not call the message API at all on a roster hit", async () => {
    const r = await loadedRoster();
    const spy = jest.fn(async () => ({ ok: true, json: async () => ({ sender: OWNER }) })) as unknown as typeof fetch;
    await resolveAttribution(proxied("Ash"), OWNER, undefined, spy, BLUE, BLUE_SYS, r);
    expect(spy).not.toHaveBeenCalled();
  });

  it("Blue's front is never promoted to owner", async () => {
    const r = await loadedRoster();
    const got = await resolveAttribution(proxied("Tide"), OWNER, undefined, deadApi, BLUE, BLUE_SYS, r);
    expect(got).toMatchObject({ isOwner: false, discordUserId: BLUE, frontMember: "Tide" });
  });

  it("roster miss + dead API + captured sender id still identifies the owner", async () => {
    const r = await loadedRoster();
    const got = await resolveAttribution(proxied("BrandNewAlter"), OWNER, OWNER, deadApi, BLUE, BLUE_SYS, r);
    expect(got).toMatchObject({ isOwner: true, discordUserId: OWNER, source: "fallback" });
  });

  it("roster miss + dead API + nothing captured stays unknown, never owner", async () => {
    const r = await loadedRoster();
    const got = await resolveAttribution(proxied("Stranger"), OWNER, undefined, deadApi, BLUE, BLUE_SYS, r);
    expect(got).toMatchObject({ isOwner: false, discordUserId: "unknown", source: "fallback" });
  });

  it("no roster passed: behavior is exactly the previous API path", async () => {
    const api = jest.fn(async () => ({ ok: true, json: async () => ({ sender: OWNER, member: { name: "Ash" } }) })) as unknown as typeof fetch;
    const got = await resolveAttribution(proxied("Ash"), OWNER, undefined, api, BLUE, BLUE_SYS, null);
    expect(got).toMatchObject({ isOwner: true, frontMember: "Ash", source: "pluralkit" });
  });

  it("retries the message API once when the first call loses the race with PK's own write", async () => {
    let calls = 0;
    const flaky = jest.fn(async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ sender: OWNER, member: { name: "Ash" } }) };
    }) as unknown as typeof fetch;
    const got = await resolveAttribution(proxied("Ash"), OWNER, undefined, flaky, BLUE, BLUE_SYS, null);
    expect(calls).toBe(2);
    expect(got).toMatchObject({ isOwner: true, frontMember: "Ash", source: "pluralkit" });
  });
});
