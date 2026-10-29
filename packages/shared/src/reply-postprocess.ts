// Post-processing of one model reply text (2026-10-29, review N-1). Extracted from bot-message-handler
// so a script-bleed regeneration runs the SAME steps as the first text: the care-follow-up [PASS] hold,
// the [model:<key>] strip (+ the caller's self-switch side effect), and the [LANDS: ...] marker parse.
// Before this, `response = regen.text` landed after all three: a regen reply kept a raw [model:x] or
// [LANDS: ...] in the room, skipped the PASS hold, and convoLand read the discarded first text's
// resolution. Pure apart from `onModelToken`.

import { isPass } from "./director-invite.js";
import { parseLandMarker } from "./thread-spine.js";

export const MODEL_TOKEN_RE = /\[model:([^\]]+)\]/i;

export interface PostProcessedReply {
  text: string;
  /** The [LANDS: ...] resolution of THIS text (null without a spine or a marker). */
  spineResolution: string | null;
  /** A care follower chose [PASS]: nothing is sent. */
  passed: boolean;
}

export interface PostProcessOpts {
  /** This turn is a care follow-up (a [PASS] reply is a real choice). */
  careFollowUp: boolean;
  /** A thread spine is active (only then is [LANDS: ...] parsed). */
  hasSpine: boolean;
  /** Called with the lowercased key when the text carries a [model:<key>] token (already stripped). */
  onModelToken: (switchKey: string) => void;
}

export function postProcessReply(raw: string, o: PostProcessOpts): PostProcessedReply {
  let text = raw;
  if (o.careFollowUp && text && isPass(text)) return { text, spineResolution: null, passed: true };

  if (text) {
    const tokenMatch = text.match(MODEL_TOKEN_RE);
    if (tokenMatch) {
      text = text.replace(MODEL_TOKEN_RE, "").trim();
      o.onModelToken(tokenMatch[1]!.trim().toLowerCase());
    }
  }

  // Thread spine (task 10): strip a companion-authored [LANDS: ...] marker before ANY send path
  // (voice synthesis, text content, error-fallback content) so it never reaches Discord or TTS.
  // Without a spine there is no thread to land and the marker is not something companions are
  // prompted to emit, so nothing is parsed.
  const landed = o.hasSpine ? parseLandMarker(text) : { cleaned: text, resolution: null };
  return { text: landed.cleaned, spineResolution: landed.resolution, passed: false };
}
