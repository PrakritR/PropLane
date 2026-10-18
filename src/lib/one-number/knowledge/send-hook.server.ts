import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { captureFromManagerSend } from "./capture.server";
import { offerSaveBySms } from "./sms-offer.server";

/**
 * Called after a manager's text to a person was accepted for delivery. Files a suggested
 * knowledge entry when the text answers an escalation or edits an AI draft, then offers to save
 * it by text. Never throws and never changes the send's result.
 */
export async function learnFromManagerSend(
  db: SupabaseClient,
  args: { ownerUserId: string; actorUserId: string; toPhone: string; text: string; counterpartyRole?: string | null },
): Promise<void> {
  try {
    // A text to a teammate is not an answer to anyone's question.
    if (args.counterpartyRole === "manager") return;
    const captured = await captureFromManagerSend(db, args);
    if (!captured.captured) return;
    if (captured.via === "escalation") {
      await offerSaveBySms(db, {
        ownerUserId: args.ownerUserId,
        actorUserId: args.actorUserId,
        entry: captured.entry,
        houseLabel: captured.houseLabel,
      });
    }
  } catch {
    /* the learning loop never blocks a send */
  }
}
