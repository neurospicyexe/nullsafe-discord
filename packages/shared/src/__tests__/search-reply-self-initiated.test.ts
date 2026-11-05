// Item 9 (2026-11-05): the owner `search` command posts a deterministic ack the Hermes gateway
// never generated; it must land in STM flagged selfInitiated so hermesDelta folds it once. The
// woven read-in IS a gateway generation and must stay unflagged.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hermesDelta } from "../prompt-assembly.js";

describe("search reply STM flag", () => {
  const src = readFileSync(resolve(process.cwd(), "src/bot-message-handler.ts"), "utf8");
  it("flags search.reply selfInitiated and leaves the woven read-in alone", () => {
    expect(src).toMatch(/content: search\.reply,[^}]*selfInitiated: true/);
    expect(src).toMatch(/content: woven,(?![^}]*selfInitiated)/);
  });
  it("hermesDelta folds a selfInitiated search ack once and is not fooled into treating it as the boundary", () => {
    const hist = [
      { role: "user", content: "search cats", authorName: "Crash", timestamp: 1000 },
      { role: "assistant", content: "Results: ...", timestamp: 1001, selfInitiated: true as const },
      { role: "user", content: "what did you think of the first one", authorName: "Crash", timestamp: 2000 },
    ];
    const out = hermesDelta(hist, null, 3000);
    const text = out.messages.map((m) => m.content).join("\n");
    expect(text).toContain("Results: ...");
    expect(text).toContain("search cats");
  });
});
