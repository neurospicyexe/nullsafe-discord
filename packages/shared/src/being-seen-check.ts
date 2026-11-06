// B63 being_seen, bot side. One detached ask per owner message, for this bot's own companion. The bot never
// decides the tier: Halseth does (POST /mind/being-seen/check). Only the owner's messages are reported, and
// only on arrival (a follow-up pass is not a new message). Never throws, never blocks the reply.

import type { LibrarianClient } from "./librarian.js";
import type { WriteQueue } from "./write-queue.js";

export interface BeingSeenInput {
  isOwner: boolean;
  isArrival: boolean;
  messageId: string;
  channelId: string | null;
  text: string;
  /** The message replies to one of THIS bot's own messages (sentIds, burst, or the durable ledger). */
  isReplyToMe: boolean;
}

export function fireBeingSeenCheck(
  input: BeingSeenInput,
  librarian: Pick<LibrarianClient, "beingSeenCheck">,
  writeQueue: Pick<WriteQueue, "fireAndForget">,
): boolean {
  if (!input.isOwner || !input.isArrival || !input.messageId) return false;
  try {
    writeQueue.fireAndForget(`seen:${input.messageId}`, () => librarian.beingSeenCheck({
      messageId: input.messageId, text: input.text, channelId: input.channelId, isReplyToMe: input.isReplyToMe,
    }));
    return true;
  } catch {
    return false;
  }
}
