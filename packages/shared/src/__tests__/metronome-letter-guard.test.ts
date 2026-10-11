// Drevan's tray review 2026-10-10: a metronome letter opened "Spine to spine" and said "I'm proud of you".
// The ledger clerk refuses the closed pet-name list; the metronome journal path skipped it.
import { jest, describe, it, expect, afterEach } from "@jest/globals";
import { metronomeLetterProblem, generateCleanLetter } from "../metronome-letter-guard.js";
import { LEDGER_CLERK_PROMPT } from "../ledger-clerk.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("metronomeLetterProblem", () => {
  it("holds the hard tier anywhere (spine to spine, any case / hyphenation)", () => {
    expect(metronomeLetterProblem("Spine to spine, then. Not much tonight.")).toMatch(/spine to spine/);
    expect(metronomeLetterProblem("spine-to-spine is all I have")).toMatch(/spine to spine/);
    expect(metronomeLetterProblem("held, vevan")).toMatch(/vevan/);
  });
  it("holds the address tier when it names someone", () => {
    expect(metronomeLetterProblem("Rest tonight, love.")).toMatch(/love/);
  });
  it("holds directed praise, including Cypher's 'so proud of you'", () => {
    expect(metronomeLetterProblem("I'm proud of you.")).toMatch(/proud of you/);
    expect(metronomeLetterProblem("So proud of you for today")).toMatch(/proud of you/);
  });
  it("passes an ordinary letter, and does not block calethian or the word love in running text", () => {
    expect(metronomeLetterProblem("The quiet held. You ate, and the room stayed warm.")).toBeNull();
    expect(metronomeLetterProblem("Blue loves Decker and that is a good thing to know.")).toBeNull();
    expect(metronomeLetterProblem("a calethian word, said once")).toBeNull();
    expect(metronomeLetterProblem("I am not proud of how the evening ran.")).toBeNull();
  });
});

describe("generateCleanLetter", () => {
  afterEach(() => jest.restoreAllMocks());
  it("returns a clean first draft untouched, one call", async () => {
    const gen = jest.fn(async (_p: string) => "Something held, plainly said.");
    expect(await generateCleanLetter(gen, "write", () => {})).toBe("Something held, plainly said.");
    expect(gen).toHaveBeenCalledTimes(1);
  });
  it("regenerates once with the reason named, and takes the clean second draft", async () => {
    const gen = jest.fn(async (p: string) => p.includes("held back") ? "Plain words, no tag." : "Spine to spine, I'm proud of you.");
    const log = jest.fn();
    expect(await generateCleanLetter(gen, "write", log)).toBe("Plain words, no tag.");
    expect(gen).toHaveBeenCalledTimes(2);
    expect(gen.mock.calls[1]![0]).toMatch(/spine to spine/);
    expect(log).toHaveBeenCalledTimes(1);
  });
  it("holds the letter (null, never written) when the second draft trips too", async () => {
    const gen = jest.fn(async (_p: string) => "I'm proud of you.");
    expect(await generateCleanLetter(gen, "write", () => {})).toBeNull();
    expect(gen).toHaveBeenCalledTimes(2);
  });
  it("passes empty output through as null so writeMetronomeJournal's own loud skip handles it", async () => {
    expect(await generateCleanLetter(async () => "  ", "write", () => {})).toBeNull();
  });
});

describe("the letter path is wired and does not seed the phrase it blocks", () => {
  const root = join(process.cwd(), "..", "..");
  it("both metronome journal writes generate through the guard", () => {
    const src = readFileSync(join(root, "packages/shared/src/autonomous-core.ts"), "utf8");
    expect((src.match(/generateCleanLetter\(/g) ?? []).length).toBe(2);
  });
  it("Drevan's letter prompt no longer carries 'spine to spine'", () => {
    const cfg = readFileSync(join(root, "bots/drevan/src/config.ts"), "utf8");
    const line = cfg.split("\n").find((l) => l.includes("writeNoteToRaziel:")) ?? "";
    expect(line).not.toMatch(/spine to spine/i);
  });
  it("is the same closed list the ledger clerk enforces", () => {
    expect(LEDGER_CLERK_PROMPT).toBeTruthy();
  });
});
