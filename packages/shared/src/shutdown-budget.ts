// Shutdown budget for bot-core's SIGINT/SIGTERM handler (2026-11-05). Extracted so a test can pin
// the arithmetic against ecosystem.config.js kill_timeout.
//
// Evidence: every restart with an open channel logged "closure flush ... still pending after
// 1500ms", and in the 11-04/11-05 restarts no "ledger distiller:" completion line followed before
// the process exited -- the session-close distillation (a model call + ledger writes) was killed
// mid-flight. Closure distillation takes 1-4s; the flush gets 8s.
export const SHUTDOWN_FLUSH_MS = 8000;
export const SHUTDOWN_SESSION_CLOSE_MS = 4000;
export const SHUTDOWN_SUBS_MS = 1000;
export const SHUTDOWN_BACKSTOP_MS = 13500;
