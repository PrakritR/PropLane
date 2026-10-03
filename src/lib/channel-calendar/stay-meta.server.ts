import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { managerCanAccessApplicationRecord } from "@/lib/auth/manager-application-access";
import { collectLinkedPropertyIdsForUser, managerCanAccessLeaseRecord } from "@/lib/auth/manager-lease-scope";
import { normalizeStayMetaInput, type StayMeta } from "@/lib/channel-calendar/stay-meta";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { BOOKING_STAY_META_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";

/** One record per lease/application, owned by whoever owns that lease/application. */
export function stayMetaRecordId(kind: string, refId: string): string {
  return `axis_stay_meta_${kind}_${refId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export type SaveStayMetaResult = { ok: true; meta: StayMeta } | { ok: false; status: 400 | 403 | 404; error: string };

function idVariants(id: string): string[] {
  const trimmed = id.trim();
  const normalized = normalizeApplicationAxisId(trimmed);
  return [...new Set([trimmed, trimmed.toUpperCase(), normalized, normalized.toUpperCase()].filter(Boolean))];
}

/**
 * Saves notes/details for a signed-lease or application stay. The lease or
 * application is loaded from the database and the caller's `edit` access to it
 * is checked against the session — the body's ids select a record, they never
 * vouch for ownership.
 */
export async function saveStayMeta(db: SupabaseClient, userId: string, raw: unknown): Promise<SaveStayMetaResult> {
  const input = normalizeStayMetaInput(raw);
  if (!input) return { ok: false, status: 400, error: "Invalid stay details." };

  let ownerUserId: string | null = null;
  let propertyId: string | null = null;
  if (input.kind === "lease") {
    const { data } = await db
      .from("portal_lease_pipeline_records")
      .select("id, manager_user_id, property_id")
      .eq("id", input.refId)
      .maybeSingle();
    const record = data as { manager_user_id?: string | null; property_id?: string | null } | null;
    if (!record) return { ok: false, status: 404, error: "Lease not found." };
    if (!(await managerCanAccessLeaseRecord(db, userId, { manager_user_id: record.manager_user_id ?? null, property_id: record.property_id ?? null }, "edit"))) {
      return { ok: false, status: 403, error: "Forbidden." };
    }
    ownerUserId = record.manager_user_id ?? userId;
    propertyId = record.property_id?.trim() || null;
  } else {
    const { data } = await db
      .from("manager_application_records")
      .select("id, manager_user_id, property_id, assigned_property_id")
      .in("id", idVariants(input.refId))
      .limit(1);
    const record = (data as Array<{ manager_user_id?: string | null; property_id?: string | null; assigned_property_id?: string | null }> | null)?.[0];
    if (!record) return { ok: false, status: 404, error: "Application not found." };
    if (!(await managerCanAccessApplicationRecord(db, userId, record, { level: "edit" }))) {
      return { ok: false, status: 403, error: "Forbidden." };
    }
    ownerUserId = record.manager_user_id ?? userId;
    propertyId = (record.assigned_property_id || record.property_id || "").trim() || null;
  }

  const now = new Date().toISOString();
  const { error } = await db.from("portal_schedule_records").upsert(
    {
      id: stayMetaRecordId(input.kind, input.refId),
      manager_user_id: ownerUserId,
      property_id: propertyId,
      record_type: BOOKING_STAY_META_RECORD_TYPE,
      starts_at: null,
      ends_at: null,
      row_data: { ...input, recordType: BOOKING_STAY_META_RECORD_TYPE, propertyId, updatedBy: userId },
      updated_at: now,
    },
    { onConflict: "id" },
  );
  if (error) return { ok: false, status: 400, error: "Could not save stay details." };
  return { ok: true, meta: input };
}

/** Saved stay details visible to this manager: their own, plus those on houses they co-manage. */
export async function listStayMeta(db: SupabaseClient, userId: string): Promise<StayMeta[]> {
  const linked = [...(await collectLinkedPropertyIdsForUser(db, userId))];
  const [own, shared] = await Promise.all([
    db
      .from("portal_schedule_records")
      .select("row_data")
      .eq("record_type", BOOKING_STAY_META_RECORD_TYPE)
      .eq("manager_user_id", userId)
      .limit(1000),
    linked.length
      ? db
          .from("portal_schedule_records")
          .select("row_data")
          .eq("record_type", BOOKING_STAY_META_RECORD_TYPE)
          .in("property_id", linked)
          .limit(1000)
      : Promise.resolve({ data: [] as Array<{ row_data?: unknown }>, error: null }),
  ]);
  const metas = new Map<string, StayMeta>();
  for (const row of [...(own.data ?? []), ...(shared.data ?? [])] as Array<{ row_data?: unknown }>) {
    const meta = normalizeStayMetaInput(row.row_data);
    if (meta) metas.set(`${meta.kind}:${meta.refId}`, meta);
  }
  return [...metas.values()];
}
