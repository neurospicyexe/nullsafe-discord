// Tests for Discord-thread config inheritance (2026-08-15 floor rework):
// config/gating resolve to the parent channel, storage keeps the thread's own id.

import { describe, it, expect } from "@jest/globals";
import { resolveRoutingChannelId } from "../channel-config.js";

describe("resolveRoutingChannelId", () => {
  it("a thread routes as its parent channel", () => {
    const ch = { isThread: () => true, parentId: "parent-1" };
    expect(resolveRoutingChannelId(ch, "thread-9")).toBe("parent-1");
  });

  it("a plain channel routes as itself", () => {
    const ch = { isThread: () => false, parentId: null };
    expect(resolveRoutingChannelId(ch, "chan-1")).toBe("chan-1");
  });

  it("a thread with no parentId routes as itself", () => {
    const ch = { isThread: () => true, parentId: null };
    expect(resolveRoutingChannelId(ch, "thread-9")).toBe("thread-9");
  });

  it("a mock without thread support routes as itself (test doubles, DMs)", () => {
    expect(resolveRoutingChannelId({}, "dm-1")).toBe("dm-1");
    expect(resolveRoutingChannelId(null, "dm-1")).toBe("dm-1");
    expect(resolveRoutingChannelId(undefined, "dm-1")).toBe("dm-1");
  });

  it("an isThread that throws routes as itself", () => {
    const ch = { isThread: () => { throw new Error("partial"); }, parentId: "p" };
    expect(resolveRoutingChannelId(ch, "thread-9")).toBe("thread-9");
  });
});
