import "server-only";

import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { stampSmsTestProvenance } from "@/lib/sms/sms-test-provenance.server";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

type ScheduleMutation = {
  operation: "append" | "append_event" | "cancel" | "delete" | "replace" | "patch";
  event: Record<string, unknown>;
  removeInquiryIds?: string[];
  /** Manager-only legacy approval override. Autonomous and manual creation
   * never set this; the database remains the single-winner fence for them. */
  allowConflict?: boolean;
  /** Required for a replacement. The database compares this exact active
   * lifecycle window while holding the shared schedule lock, before it makes
   * any reservation or notification-eligible state change. */
  expected?: { start: string; end: string; generation: string | null };
};

type LegacyScheduleDb = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (key: string, value: string) => {
        maybeSingle: () => Promise<{ data: { row_data?: unknown } | null; error: { message: string } | null }>;
      };
    };
    upsert: (row: unknown, options?: unknown) => Promise<{ error: { message: string } | null }>;
  };
};

/**
 * The only writer for confirmed-tour JSON payload mutations. The database RPC
 * locks the global planned-events record, applies the mutation and maintains a
 * relational slot reservation in one transaction. Keep all confirmed tour
 * paths on this boundary - read/modify/upsert would lose concurrent changes.
 */
export async function mutateConfirmedTourSchedule(
  db: Db,
  mutation: ScheduleMutation,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const event = stampSmsTestProvenance(mutation.event);
  // Old unit fixtures and pre-migration local databases do not expose RPCs.
  // Production always takes the RPC path; this compatibility path preserves
  // the former single-process behavior while a migration is being applied.
  if (typeof (db as { rpc?: unknown }).rpc !== "function") {
    const client = db as never as LegacyScheduleDb;
    const { data, error } = await client.from("portal_schedule_records").select("row_data").eq("id", "axis_admin_planned_events_v1").maybeSingle();
    if (error) return { ok: false, reason: error.message };
    const rowData = data?.row_data as { payload?: unknown } | undefined;
    const rows = Array.isArray(rowData?.payload) ? rowData.payload.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object")) : [];
    const id = String(event.id ?? "");
    if (mutation.operation === "replace") {
      const current = rows.find((row) => row.id === id);
      if (!current || typeof current.canceledAt === "string" && current.canceledAt) {
        return { ok: false, reason: "stale_event" };
      }
      if (!mutation.expected || current.start !== mutation.expected.start || current.end !== mutation.expected.end ||
        (typeof current.rescheduleNotificationGeneration === "string" ? current.rescheduleNotificationGeneration : null) !== mutation.expected.generation) {
        return { ok: false, reason: "stale_event" };
      }
    }
    const next = mutation.operation === "append" || mutation.operation === "append_event"
      ? [...rows, event]
      : mutation.operation === "delete"
        ? rows.filter((row) => row.id !== id)
      : rows.map((row) => row.id === id
        ? mutation.operation === "cancel" ? { ...event, canceledAt: new Date().toISOString() } : event
        : row);
    const write = await client.from("portal_schedule_records").upsert([{
      id: "axis_admin_planned_events_v1", manager_user_id: null, property_id: null,
      record_type: "axis_admin_planned_events_v1",
      row_data: { ...(rowData ?? {}), id: "axis_admin_planned_events_v1", recordType: "axis_admin_planned_events_v1", managerUserId: null, propertyId: null, payload: next },
      updated_at: new Date().toISOString(),
    }], { onConflict: "id" });
    if (write.error) return { ok: false, reason: write.error.message };
    if (mutation.removeInquiryIds?.length) {
      const inquiry = await client.from("portal_schedule_records").select("row_data").eq("id", "axis_admin_partner_inquiries_v1").maybeSingle();
      if (inquiry.error) return { ok: false, reason: inquiry.error.message };
      const inquiryData = inquiry.data?.row_data as { payload?: unknown } | undefined;
      const remove = new Set(mutation.removeInquiryIds);
      const inquiryRows = Array.isArray(inquiryData?.payload)
        ? inquiryData.payload.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
        : [];
      const inquiryWrite = await client.from("portal_schedule_records").upsert([{
        id: "axis_admin_partner_inquiries_v1", manager_user_id: null, property_id: null,
        record_type: "axis_admin_partner_inquiries_v1",
        row_data: { ...(inquiryData ?? {}), id: "axis_admin_partner_inquiries_v1", recordType: "axis_admin_partner_inquiries_v1", managerUserId: null, propertyId: null, payload: inquiryRows.filter((row) => !remove.has(String(row.id ?? ""))) },
        updated_at: new Date().toISOString(),
      }], { onConflict: "id" });
      if (inquiryWrite.error) return { ok: false, reason: inquiryWrite.error.message };
    }
    return { ok: true };
  }
  const { data, error } = await db.rpc("mutate_confirmed_tour_schedule", {
    p_operation: mutation.operation,
    p_event: event,
    p_remove_inquiry_ids: mutation.removeInquiryIds ?? [],
    p_allow_conflict: mutation.allowConflict === true,
    p_expected_start: mutation.expected?.start ?? null,
    p_expected_end: mutation.expected?.end ?? null,
    p_expected_generation: mutation.expected?.generation ?? null,
    p_expected_generation_known: Boolean(mutation.expected),
  });
  if (error) return { ok: false, reason: error.message };
  const result = data as { ok?: unknown; reason?: unknown } | null;
  if (result?.ok === true) return { ok: true };
  return { ok: false, reason: typeof result?.reason === "string" ? result.reason : "Tour schedule unavailable." };
}


type ProspectTourIdentity =
  | { trustedPhoneE164: string; testActorUserId?: never }
  | { trustedPhoneE164?: null; testActorUserId: string };


export async function confirmProspectSmsTourOffer(
  db: Db,
  args: {
    managerUserId: string;
    conversationKey: string;
    propertyId: string;
    contactName: string;
    contactEmail?: string | null;
    offer: Record<string, unknown>;
    event: Record<string, unknown>;
    idempotencyKey: string;
    burstId: string;
    burstRevision: number;
    agreementSourceMessageId: string;
    /** Required by the durable worker. Optional only for legacy callers, which
     * the database rejects as an incomplete claimed snapshot. */
    claimedSourceIds?: string[];
    workerId: string;
  } & ProspectTourIdentity,
): Promise<{ ok: true; idempotent: boolean; plannedEventId: string; status: string } | { ok: false; reason: string }> {
  const rpcArgs: Record<string, unknown> = {
    p_manager_user_id: args.managerUserId,
    p_conversation_key: args.conversationKey,
    p_property_id: args.propertyId,
    p_contact_name: args.contactName,
    p_contact_email: args.contactEmail?.trim() || null,
    p_offer: args.offer,
    p_event: stampSmsTestProvenance(args.event),
    p_idempotency_key: args.idempotencyKey,
  };
  if (args.testActorUserId) rpcArgs.p_test_actor_user_id = args.testActorUserId;
  else rpcArgs.p_trusted_phone_e164 = args.trustedPhoneE164;
  if (args.burstId && args.burstRevision !== undefined && args.agreementSourceMessageId && args.workerId) {
    Object.assign(rpcArgs, {
      p_burst_id: args.burstId,
      p_burst_revision: args.burstRevision,
      p_agreement_source_message_id: args.agreementSourceMessageId,
      p_claimed_source_ids: args.claimedSourceIds ?? [],
      p_worker_id: args.workerId,
    });
  }
  const { data, error } = await db.rpc(
    args.testActorUserId ? "confirm_authenticated_sms_test_tour_offer" : "confirm_prospect_sms_tour_offer",
    rpcArgs,
  );
  if (error) return { ok: false, reason: error.message };
  const result = data as { ok?: unknown; reason?: unknown; idempotent?: unknown; plannedEventId?: unknown; status?: unknown } | null;
  if (result?.ok !== true || typeof result.plannedEventId !== "string") {
    return { ok: false, reason: typeof result?.reason === "string" ? result.reason : "That tour time is no longer available." };
  }
  return {
    ok: true,
    idempotent: result.idempotent === true,
    plannedEventId: result.plannedEventId,
    status: typeof result.status === "string" ? result.status : "confirmed",
  };
}

export async function prepareProspectSmsTourOffer(
  db: Db,
  args: {
    managerUserId: string;
    conversationKey: string;
    propertyId: string;
    contactName: string;
    contactEmail?: string | null;
    offer: Record<string, unknown>;
    burstId: string;
    burstRevision: number;
    workerId: string;
  } & ProspectTourIdentity,
): Promise<{ ok: true; stateId: string; stateRevision: number } | { ok: false; reason: string }> {
  const { data, error } = await db.rpc(
    args.testActorUserId ? "prepare_authenticated_sms_test_tour_offer" : "prepare_prospect_sms_tour_offer",
    {
    p_manager_user_id: args.managerUserId,
    p_conversation_key: args.conversationKey,
    p_property_id: args.propertyId,
    ...(args.testActorUserId
      ? { p_test_actor_user_id: args.testActorUserId }
      : { p_trusted_phone_e164: args.trustedPhoneE164 }),
    p_contact_name: args.contactName,
    p_contact_email: args.contactEmail?.trim() || null,
    p_offer: args.offer,
    p_burst_id: args.burstId,
    p_burst_revision: args.burstRevision,
    p_worker_id: args.workerId,
    },
  );
  if (error) return { ok: false, reason: error.message };
  const result = data as { ok?: unknown; reason?: unknown; stateId?: unknown; stateRevision?: unknown } | null;
  if (result?.ok !== true || typeof result.stateId !== "string") {
    return { ok: false, reason: typeof result?.reason === "string" ? result.reason : "That tour offer is stale." };
  }
  return { ok: true, stateId: result.stateId, stateRevision: Number(result.stateRevision) };
}
