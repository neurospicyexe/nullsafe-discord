// Process-wide connection tuning for VPS -> Cloudflare fetches (2026-07-21).
//
// The VPS has no working IPv6 route (curl -6 to halseth fails instantly), and
// Node's happy-eyeballs connector (autoSelectFamily / internalConnectMultiple)
// uses a 250ms per-address attempt timeout by default -- when SYN latency to
// Cloudflare spikes past it, EVERY address in the pool "times out" and the whole
// fetch dies with AggregateError [ETIMEDOUT]. 222 scheduler kills between
// 2026-06-28 and 07-21 (council, briefings, motifs, guardian catch-up) trace here.
//
// ipv4first stops wasting attempts on the dead IPv6 route; the 2s attempt
// timeout survives latency spikes. Side-effect module: imported first by
// shared/index.ts (bots) and the autonomous-worker entry. Guarded so an older
// Node without these APIs can never break boot.

import net from "node:net";
import dns from "node:dns";

try { net.setDefaultAutoSelectFamilyAttemptTimeout?.(2_000); } catch { /* keep defaults */ }
try { dns.setDefaultResultOrder?.("ipv4first"); } catch { /* keep defaults */ }
