export type CompanionId = "cypher" | "drevan" | "gaia";
export type RunType = "exploration" | "reflection" | "synthesis" | "continuation" | "signal_audit";

export interface Seed {
  id: string;
  companion_id: CompanionId;
  seed_type: "topic" | "question" | "reflection_prompt";
  content: string;
  priority: number;
  used_at: string | null;
  created_at: string;
  claim_source: string | null;  // companion_id if companion-initiated live claim
  justification: string | null; // what is live and why; present when claim_source is set
}

export interface ActiveThread {
  thread_key: string;
  title: string;
  status: "open" | "paused";
  last_position: number | null;
  last_run_at: string | null;
  last_entry_snippet: string | null;
}

export interface GrowthJournalEntry {
  companion_id: CompanionId;
  entry_type: "learning" | "insight" | "connection" | "question" | "signal_audit";
  content: string;
  source: "autonomous" | "conversation" | "reflection";
  tags?: string[];
  run_id?: string;
  thread_id?: string;
}

export interface GrowthPattern {
  companion_id: CompanionId;
  pattern_text: string;
  evidence?: string[];
  strength?: number;
  run_id?: string;
}

export interface GrowthMarker {
  companion_id: CompanionId;
  marker_type: "milestone" | "shift" | "realization";
  description: string;
  related_pattern_id?: string;
  run_id?: string;
  thread_id?: string;
}

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

/** Accumulator threaded through all pipeline phases. */
export interface PipelineContext {
  companionId: CompanionId;
  runId: string;
  runType: RunType;
  identityText: string;
  orientSummary: string;
  recentGrowth: Array<{ type: string; content: string }>;
  activePatterns: string[];
  unexaminedDreamIds: string[];
  openLoops: Array<{ id: string; text: string }>;
  pressureFlags: string[];
  activeThreads: ActiveThread[];
  seed: Seed | null;
  seedDecisionReason: string | null; // reasoning from orient-aware decision
  threadId: string | null;           // set when continuing or starting a thread
  threadPosition: number | null;
  searchResults: TavilyResult[];
  explorationSummary: string | null;
  journalEntry: GrowthJournalEntry | null;
  newPatterns: GrowthPattern[];
  newMarkers: GrowthMarker[];
  reflectionText: string | null;
  newSeeds: string[];
  journalEntryId: string | null;
  tokensUsed: number;
  artifactsCreated: number;
}
