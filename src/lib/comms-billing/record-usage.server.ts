import type { SupabaseClient } from "@supabase/supabase-js";
import { unitPriceCentsForMeter } from "./rates";
import {
  reserveCommsCredit,
  finishCommsCredit,
  type CommsReservationInput,
} from "./wallet.server";
export type RecordCommsUsageInput = CommsReservationInput;

/** Record unavoidable inbound costs without dropping the message or overdrawing credit.
 * Outgoing actions must reserve before dispatch and settle that same key here.
 */
export async function recordManagerCommsUsage(
  db: SupabaseClient,
  input: RecordCommsUsageInput,
) {
  const unavoidable =
    input.meter === "sms_inbound_segment" ||
    input.meter === "voice_minute" ||
    input.meter === "voice_recording_minute";
  const result = await reserveCommsCredit(db, input, unavoidable);
  const totalCents = Math.round(
    unitPriceCentsForMeter(input.meter) * (input.quantity ?? 1),
  );
  if (!result.allowed) return { recorded: false, duplicate: false, totalCents };
  if (result.state === "reserved")
    await finishCommsCredit(db, input.managerUserId, input.idempotencyKey);
  if (!result.duplicate && result.state === "settled") {
    const { maybeNotifyCommsBudgetThreshold } =
      await import("./notifications.server");
    await maybeNotifyCommsBudgetThreshold(db, input.managerUserId).catch(
      () => undefined,
    );
  }
  return {
    recorded: !result.duplicate,
    duplicate: result.duplicate,
    totalCents,
  };
}
