export interface SwarmReply {
  packet_id: string;
  thread_id: string;
  responses: Record<string, string | null>;
  depth: number;
  status: "ok" | "error";
  trace?: Record<string, unknown>;
}

/** Detect whether a Brain response is a SwarmReply (Phase 2) vs AgentReply (Phase 1). */
export function isSwarmReply(data: unknown): data is SwarmReply {
  return (
    typeof data === "object" &&
    data !== null &&
    "responses" in data &&
    typeof (data as Record<string, unknown>).responses === "object"
  );
}
