// The task check reads the task list before it speaks (2026-09-26). Raziel's first tray review
// found the model-guessed "No open tasks -- clean slate" ticks were the bulk of the drafts.
import { taskCheckPrompt, liveTasks, TASK_CHECK_MAX_LISTED, type TaskCheckRow } from "../task-check.js";

const row = (o: Partial<TaskCheckRow>): TaskCheckRow => ({
  id: "t", title: "thing", priority: "normal", status: "open", due_at: null, assigned_to: null, ...o,
});

describe("taskCheckPrompt", () => {
  it("returns null when there is nothing live -- the caller must stay silent, not post a clean-slate line", () => {
    expect(taskCheckPrompt([])).toBeNull();
    expect(taskCheckPrompt([row({ status: "done" })])).toBeNull();
  });

  it("hands the model the real list, urgent first, with due dates and overdue flagged", () => {
    const p = taskCheckPrompt([
      row({ title: "low thing", priority: "low" }),
      row({ title: "the deck", priority: "urgent", due_at: "2026-09-20T00:00:00Z", assigned_to: "cypher" }),
      row({ title: "later", priority: "high", due_at: "2026-10-05T00:00:00Z", status: "in_progress" }),
    ], new Date("2026-09-26T12:00:00Z"));
    expect(p).not.toBeNull();
    const lines = p!.split("\n");
    expect(lines[0]).toBe("Open tasks right now (3):");
    expect(lines[1]).toBe("- the deck (urgent) due 2026-09-20 (OVERDUE) [cypher]");
    expect(lines[2]).toBe("- later (in progress) (high) due 2026-10-05");
    expect(lines[3]).toBe("- low thing (low)");
    expect(p).toContain("One line in Cypher's voice");
  });

  it("caps the listing and says how many more", () => {
    const rows = Array.from({ length: TASK_CHECK_MAX_LISTED + 3 }, (_, i) => row({ id: String(i), title: `t${i}` }));
    const p = taskCheckPrompt(rows)!;
    expect(p).toContain(`(+3 more)`);
    expect(p.split("\n").filter(l => l.startsWith("- ")).length).toBe(TASK_CHECK_MAX_LISTED);
  });
});

describe("liveTasks", () => {
  it("drops done rows and sorts by priority then due date", () => {
    const out = liveTasks([
      row({ id: "a", due_at: "2026-10-02" }),
      row({ id: "b", status: "done", priority: "urgent" }),
      row({ id: "c", due_at: "2026-10-01" }),
    ]);
    expect(out.map(t => t.id)).toEqual(["c", "a"]);
  });
});
