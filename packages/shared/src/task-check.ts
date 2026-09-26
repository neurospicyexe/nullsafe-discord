/**
 * The task check reads the task list before it speaks (2026-09-26).
 *
 * WHY: Cypher's nightly `task_check` cron asked the model "Check in on open tasks. One line."
 * with NO tasks in the prompt. The model guessed: "16 open" one night, "No open tasks -- clean
 * slate" the next, every one posted to the heartbeat channel and written as a `[metronome/
 * task_check]` continuity note. Raziel's first tray review (09-26) found those ticks were the bulk
 * of the drafts: 3 of the first 20 were empty task ticks, and none of them were memory. A check
 * that does not check is a presence ping wearing a task label.
 *
 * Now: fetch the open + in-progress tasks, and if there are none, say nothing and write nothing.
 * If there are some, hand the model the real list so the one line is about something.
 */

export interface TaskCheckRow {
  id: string;
  title: string;
  priority: "low" | "normal" | "high" | "urgent";
  status: "open" | "in_progress" | "done";
  due_at: string | null;
  assigned_to: string | null;
}

export const TASK_CHECK_MAX_LISTED = 8;

/** Open + in-progress rows only, urgent first, then by due date. */
export function liveTasks(rows: readonly TaskCheckRow[]): TaskCheckRow[] {
  const rank: Record<TaskCheckRow["priority"], number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  return rows
    .filter(r => r.status === "open" || r.status === "in_progress")
    .sort((a, b) => (rank[a.priority] - rank[b.priority]) || ((a.due_at ?? "9999") < (b.due_at ?? "9999") ? -1 : 1));
}

/**
 * The user turn for the task-check inference, or `null` when there is nothing to check in on --
 * the caller must then skip the post AND the continuity note, not send a "clean slate" line.
 */
export function taskCheckPrompt(rows: readonly TaskCheckRow[], now: Date = new Date()): string | null {
  const live = liveTasks(rows);
  if (live.length === 0) return null;
  const today = now.toISOString().slice(0, 10);
  const lines = live.slice(0, TASK_CHECK_MAX_LISTED).map(t => {
    const due = t.due_at ? ` due ${t.due_at.slice(0, 10)}${t.due_at.slice(0, 10) < today ? " (OVERDUE)" : ""}` : "";
    const who = t.assigned_to ? ` [${t.assigned_to}]` : "";
    const state = t.status === "in_progress" ? " (in progress)" : "";
    return `- ${t.title}${state} (${t.priority})${due}${who}`;
  });
  const more = live.length > TASK_CHECK_MAX_LISTED ? `\n(+${live.length - TASK_CHECK_MAX_LISTED} more)` : "";
  return [
    `Open tasks right now (${live.length}):`,
    ...lines,
    more,
    "",
    "Check in on these. One line in Cypher's voice. Direct. Name what actually moves the needle; do not list them back.",
  ].filter(Boolean).join("\n");
}
