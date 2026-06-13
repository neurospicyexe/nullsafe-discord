// dream-associate.ts (take 3) -- thin trigger; the association modes (entity-cluster +
// temporal-pattern) run server-side in Halseth (handlers/dream-associate.ts) over each
// companion's recent growth_journal. Halseth-only writes; no floor lock needed.

import { associateDreams } from "./halseth-client.js";

export async function runDreamAssociate(): Promise<void> {
  const res = await associateDreams();
  const summary = Object.entries(res.written ?? {}).map(([id, n]) => `${id} ${n}`).join(", ");
  console.log(`[dreams] associate tick: wrote -> ${summary || "none"}`);
}
