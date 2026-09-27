import type { SupabaseClient } from "@supabase/supabase-js";
import type { SmsCounterpartyRole } from "@/lib/sms-conversation-identity";
import { postgresInstantMicros } from "@/lib/sms/postgres-instant.mjs";

export type ResolvedInboundOriginal = {
  sid: string;
  receiptOwner: string;
  owner: string;
  status: "processing" | "retryable" | "completed";
  body: string;
  fromPhone: string;
  toPhone: string;
  occurredAt: string;
  role: SmsCounterpartyRole;
  userId: string | null;
  conversationKey: string | null;
  workLineId: string | null;
  ingress: boolean;
  source: "receipt_payload" | "durable_log";
};

export async function resolveInboundOriginal(
  db: SupabaseClient, sid: string, expectedOwner: string,
): Promise<ResolvedInboundOriginal> {
  const { data, error } = await db.rpc("resolve_sms_completed_receipt_original", {
    p_sid: sid, p_expected_owner: expectedOwner,
  });
  if (error) throw new Error("inbound_original_lookup_failed");
  if (!data || data.ok !== true) throw new Error(`inbound_original_${String(data?.reason ?? "unavailable")}`);
  if (data.sid !== sid || data.owner !== expectedOwner || typeof data.receiptOwner !== "string" ||
      typeof data.body !== "string" || typeof data.fromPhone !== "string" || typeof data.toPhone !== "string" ||
      !/^\+[0-9]{10,15}$/.test(data.fromPhone) || !/^\+[0-9]{10,15}$/.test(data.toPhone) ||
      !["processing", "retryable", "completed"].includes(data.status) ||
      !["prospect", "resident", "applicant", "vendor", "manager", "admin", "unknown"].includes(data.role) ||
      !(data.userId === null || typeof data.userId === "string") ||
      typeof data.ingress !== "boolean" ||
      postgresInstantMicros(data.occurredAt) === null ||
      !["receipt_payload", "durable_log"].includes(data.source) ||
      (data.source === "durable_log" && data.status !== "completed")) {
    throw new Error("inbound_original_invalid_result");
  }
  return data as ResolvedInboundOriginal;
}
