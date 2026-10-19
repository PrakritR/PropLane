import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { householdChargeDueDate, type HouseholdCharge } from "@/lib/household-charges";
import { propertyBriefFromRow } from "@/lib/one-number/knowledge/scope.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { hasSmsTestProvenance } from "@/lib/sms/sms-test-provenance";
import { parseFlexibleLocalDate } from "@/lib/rental-application/lease-dates";
import { pacificTodayKey } from "@/lib/sheet-sync/dates";
import { tenancyRowFromRecord } from "@/lib/reminders/subjects/tenancy.server";
import { firstNameOf, type HouseSubject, type LeaseSubject } from "./moments";

/**
 * The plain subjects the sweep asks `moments.ts` about: signed leases (the residents), their
 * houses, and the rent charges due today. Reads only; every query is bounded.
 */

const MAX_ROWS = 1000;
const RENT_KINDS: ReadonlySet<string> = new Set(["rent", "first_month_rent", "prorated_rent", "prorated_last_month_rent"]);

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function localDateKey(date: Date | null): string | null {
  if (!date) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export type HouseDirectoryEntry = HouseSubject;

/** Houses by id, each with its workspace (the house's own, else its owner's default workspace). */
export async function loadHouseDirectory(
  db: SupabaseClient,
  propertyIds: readonly string[],
): Promise<Map<string, HouseSubject>> {
  const out = new Map<string, HouseSubject>();
  const ids = [...new Set(propertyIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const { data, error } = await db
    .from("manager_property_records")
    .select("id, manager_user_id, workspace_id, property_data, row_data")
    .in("id", ids);
  if (error) throw error;
  const owners = new Set<string>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) owners.add(str(row.manager_user_id));
  const defaults = new Map<string, string>();
  if (owners.size > 0) {
    const { data: workspaces } = await db
      .from("portal_workspaces")
      .select("id, owner_user_id")
      .eq("is_default", true)
      .in("owner_user_id", [...owners]);
    for (const w of (workspaces ?? []) as Array<Record<string, unknown>>) defaults.set(str(w.owner_user_id), str(w.id));
  }
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const brief = propertyBriefFromRow(row);
    const ownerUserId = str(row.manager_user_id);
    const workspaceId = brief.workspaceId ?? defaults.get(ownerUserId) ?? "";
    if (!brief.id || !ownerUserId || !workspaceId) continue;
    out.set(brief.id, {
      ownerUserId,
      workspaceId,
      propertyId: brief.id,
      propertyLabel: brief.label,
      houseInfo: brief.houseInfo,
    });
  }
  return out;
}

/**
 * Every resident with a fully signed, not voided lease. `onlyOwner` narrows to one workspace owner
 * (the approval path); the sweep reads them all.
 */
export async function loadLeaseSubjects(
  db: SupabaseClient,
  opts: { onlyOwner?: string; houses?: Map<string, HouseSubject>; now?: Date } = {},
): Promise<LeaseSubject[]> {
  let query = db.from("portal_lease_pipeline_records").select("manager_user_id, row_data").limit(MAX_ROWS);
  if (opts.onlyOwner) query = query.eq("manager_user_id", opts.onlyOwner);
  const { data, error } = await query;
  if (error) throw error;

  type Raw = { ownerUserId: string; row: Record<string, unknown> };
  const raws: Raw[] = [];
  for (const record of (data ?? []) as Array<{ manager_user_id?: unknown; row_data?: unknown }>) {
    const row = (record.row_data ?? null) as Record<string, unknown> | null;
    const ownerUserId = str(record.manager_user_id);
    if (!row || !ownerUserId || hasSmsTestProvenance(row)) continue;
    if (!str(row.fullySignedAt) || str(row.voidedAt)) continue;
    if (!str(row.id) || !str(row.propertyId)) continue;
    raws.push({ ownerUserId, row });
  }
  if (raws.length === 0) return [];

  const houses = opts.houses ?? (await loadHouseDirectory(db, raws.map((r) => str(r.row.propertyId))));

  // Explicit move-out dates live on the approved application row, keyed by resident email.
  const moveOutByResident = new Map<string, string>();
  const owners = [...new Set(raws.map((r) => r.ownerUserId))];
  const { data: apps } = await db
    .from("manager_application_records")
    .select("id, manager_user_id, resident_email, row_data")
    .in("manager_user_id", owners)
    .limit(MAX_ROWS);
  for (const record of (apps ?? []) as Array<{ id: string; manager_user_id: string | null; resident_email: string | null; row_data: Record<string, unknown> }>) {
    if (!record.row_data) continue;
    const tenancy = tenancyRowFromRecord(record);
    const moveOut = localDateKey(tenancy?.moveOut ?? null);
    if (!tenancy || !moveOut) continue;
    // A resident with an old tenancy row and a new one keeps the LATER date, so a past move-out never hides a current stay.
    const key = `${tenancy.managerUserId}|${tenancy.residentEmail}`;
    const known = moveOutByResident.get(key);
    if (!known || moveOut > known) moveOutByResident.set(key, moveOut);
  }
  const todayKey = pacificTodayKey(opts.now ?? new Date());

  const userIds = [...new Set(raws.map((r) => str(r.row.residentUserId)).filter(Boolean))];
  const phones = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: profiles } = await db.from("profiles").select("id, phone, phone_verified_at").in("id", userIds);
    for (const p of (profiles ?? []) as Array<Record<string, unknown>>) {
      const key = normalizeConsentPhone(str(p.phone));
      if (p.phone_verified_at && /^\d{10}$/.test(key)) phones.set(str(p.id), key);
    }
  }

  const out: LeaseSubject[] = [];
  for (const { ownerUserId, row } of raws) {
    const house = houses.get(str(row.propertyId));
    if (!house || house.ownerUserId !== ownerUserId) continue;
    const application = (row.application ?? {}) as Record<string, unknown>;
    const email = str(row.residentEmail).toLowerCase();
    const userId = str(row.residentUserId);
    const signedAt = str(row.fullySignedAt);
    const moveOut = moveOutByResident.get(`${ownerUserId}|${email}`) ?? null;
    // Someone who has already moved out is not a house audience (house-wide notices, announcements).
    // Today's move-out stays in: that is the day the move-out moment fires.
    if (moveOut && moveOut < todayKey) continue;
    out.push({
      leaseId: str(row.id),
      ownerUserId,
      workspaceId: house.workspaceId,
      propertyId: house.propertyId,
      propertyLabel: house.propertyLabel,
      roomLabel: str(row.roomChoice) || str(row.unit) || null,
      residentName: str(row.residentName) || "Resident",
      firstName: firstNameOf(str(row.residentName)),
      residentUserId: userId || null,
      residentEmail: email,
      phoneKey: userId ? (phones.get(userId) ?? null) : null,
      signedKey: signedAt ? pacificTodayKey(new Date(signedAt)) : null,
      moveIn: localDateKey(parseFlexibleLocalDate(str(application.leaseStart))),
      moveOut,
    });
  }
  return out;
}

/** Property ids with a pending rent charge due on `todayKey` (Pacific). Names and amounts never leave this function. */
export async function loadRentDueToday(db: SupabaseClient, todayKey: string): Promise<Set<string>> {
  const { data, error } = await db
    .from("portal_household_charge_records")
    .select("row_data")
    .eq("status", "pending")
    .limit(5000);
  if (error) throw error;
  const out = new Set<string>();
  for (const record of (data ?? []) as Array<{ row_data: (HouseholdCharge & { smsTestSessionId?: string }) | null }>) {
    const charge = record.row_data;
    if (!charge?.id || charge.smsTestSessionId || !RENT_KINDS.has(charge.kind)) continue;
    const propertyId = str(charge.propertyId);
    if (!propertyId) continue;
    if (localDateKey(householdChargeDueDate(charge)) === todayKey) out.add(propertyId);
  }
  return out;
}

export type ScheduledService = {
  entityId: string;
  ownerUserId: string;
  propertyId: string;
  /** The room or area the service is in. */
  unit: string;
  title: string;
  /** "Tue, Oct 21, 10:00 AM" or whatever the row's own label says. */
  window: string;
  scheduledAtIso: string | null;
};

/** Services scheduled in the last day, from the action-event bus ('scheduled' / 'rescheduled'). */
export async function loadRecentlyScheduledServices(db: SupabaseClient, now: Date): Promise<ScheduledService[]> {
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const { data, error } = await db
    .from("action_events")
    .select("event_key, entity_id, manager_user_id, event_type")
    .eq("domain", "work_order")
    .in("event_type", ["scheduled", "rescheduled"])
    .gte("occurred_at", since)
    .limit(200);
  if (error) throw error;
  const out: ScheduledService[] = [];
  for (const event of (data ?? []) as Array<Record<string, unknown>>) {
    const entityId = str(event.entity_id);
    if (!entityId) continue;
    const { data: record } = await db
      .from("portal_work_order_records")
      .select("manager_user_id, row_data")
      .eq("id", entityId)
      .maybeSingle();
    const row = ((record as { row_data?: unknown } | null)?.row_data ?? null) as Record<string, unknown> | null;
    const ownerUserId = str((record as { manager_user_id?: unknown } | null)?.manager_user_id);
    if (!row || !ownerUserId || hasSmsTestProvenance(row)) continue;
    const propertyId = str(row.assignedPropertyId) || str(row.propertyId);
    if (!propertyId) continue;
    out.push({
      entityId,
      ownerUserId,
      propertyId,
      unit: str(row.unit),
      title: str(row.title),
      window: str(row.scheduled),
      scheduledAtIso: str(row.scheduledAtIso) || null,
    });
  }
  return out;
}
