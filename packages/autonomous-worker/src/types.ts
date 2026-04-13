export type CompanionId = "cypher" | "drevan" | "gaia";
export type RunType = "exploration" | "reflection" | "synthesis";

export interface Seed {
  id: string;
  companion_id: CompanionId;
  seed_type: "topic" | "question" | "reflection_prompt";
  content: string;
  priority: number;
  used_at: string | null;
  created_at: string;
}

export interface GrowthJournalEntry {
  companion_id: CompanionId;
  entry_type: "learning" | "insight" | "connection" | "question";
  content: string;
  source: "autonomous" | "conversation" | "reflection";
  tags?: string[];
  run_id?: string;
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
}

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

/** Accumulator threaded through all 6 pipeline phases. */
export interface PipelineContext {
  companionId: CompanionId;
  runId: string;
  runType: RunType;
  identityText: string;
  orientSummary: string;
  recentGrowth: Array<{ type: string; content: string }>;
  activePatterns: string[];
  unexaminedDreamIds: string[]; // dream IDs surfaced at orient -- cleared after successful write
  seed: Seed | null;
  searchResults: TavilyResult[];
  explorationSummary: string | null;
  journalEntry: GrowthJournalEntry | null;
  newPatterns: GrowthPattern[];
  newMarkers: GrowthMarker[];
  reflectionText: string | null;
  newSeeds: string[];
  journalEntryId: string | null; // set by write phase after successful journal persist
  tokensUsed: number;
  artifactsCreated: number;
}
