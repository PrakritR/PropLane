import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type CommsBillingMeter,
  unitPriceCentsForMeter,
} from "@/lib/comms-billing/rates";
import { maybeNotifyCommsBudgetThreshold } from "@/lib/comms-billing/notifications.server";

export type RecordCommsUsageInput = {
  managerUserId: string;
  meter: CommsBillingMeter;
  quantity?: number;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
};

export async function recordManagerCommsUsage(
  db: SupabaseClient,
  input: RecordCommsUsageInput,
): Promise<{ recorded: boolean; totalCents: number; duplicate: boolean }> {
  const managerUserId = input.managerUserId.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  const quantity = input.quantity ?? 1;
  if (!managerUserId || !idempotencyKey || quantity <= 0) {
    return { recorded: false, totalCents: 0, duplicate: false };
  }

  const unitPriceCents = unitPriceCentsForMeter(input.meter);
  const totalCents = Math.round(unitPriceCents * quantity);

  const { error } = await db.from("manager_comms_usage_events").insert({
    manager_user_id: managerUserId,
    meter: input.meter,
    quantity,
    unit_price_cents: unitPriceCents,
    total_cents: totalCents,
    idempotency_key: idempotencyKey,
    metadata: input.metadata ?? {},
  });

  if (error) {
    if (error.code === "23505") {
      return { recorded: false, totalCents, duplicate: true };
    }
    return { recorded: false, totalCents, duplicate: false };
  }

  void maybeNotifyCommsBudgetThreshold(db, managerUserId).catch(() => undefined);
  return { recorded: true, totalCents, duplicate: false };
}
