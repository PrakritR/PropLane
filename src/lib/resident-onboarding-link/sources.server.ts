import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { labelFromManagerPropertyRecordRow } from "@/lib/co-manager-property-label";
import { proplaneIdLookupVariants } from "@/lib/manager-id";
import { propertyBelongsToWorkspace } from "@/lib/one-number/link-destinations.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { ROOM_DATE_BLOCK_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";
import type { OnboardingSourceKind } from "./model";

/**
 * What PropLane already knows about the person an onboarding link is for, read from the manager's OWN record in
 * THIS workspace (an approved application, or a confirmed booking). Everything is re-derived on every read: the
 * link names a record id and nothing else.
 */
export type OnboardingFacts = {
  kind: OnboardingSourceKind;
  id: string;
  workspaceId: string;
  ownerUserId: string;
  propertyId: string;
  houseLabel: string;
  roomLabel: string;
  moveInDate: string;
  fullName: string;
  email: string;
  phoneE164: string;
  phoneKey: string;
  houseRules: string;
  /** The PropLane account already bound to the record, when there is one. */
  residentUserId: string | null;
  /** The applicant's own text consent stamp on the application (never inferred). */
  smsConsentAt: string | null;
};

export type OnboardingFactsResult =
  | { ok: true; facts: OnboardingFacts }
  | { ok: false; reason: "not_found" | "not_ready" | "no_phone" | "unreadable" };

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const rec = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});

async function workspaceOwnerOf(db: SupabaseClient, workspaceId: string): Promise<string | null> {
  const { data, error } = await db.from("portal_workspaces").select("owner_user_id").eq("id", workspaceId).maybeSingle();
  return error || !data ? null : str((data as Row).owner_user_id) || null;
}

async function houseOf(db: SupabaseClient, propertyId: string): Promise<{ label: string; rules: string } | null> {
  const { data, error } = await db.from("manager_property_records").select("id, property_data, row_data").eq("id", propertyId).maybeSingle();
  if (error || !data) return null;
  const row = data as Row;
  const submission = rec(rec(row.property_data).listingSubmission);
  const label = labelFromManagerPropertyRecordRow(row as { id?: string; property_data?: unknown; row_data?: unknown });
  return { label: label && label !== str(row.id) ? label.split(" · ")[0]! : "", rules: str(submission.houseRulesText).slice(0, 6000) };
}

export async function loadOnboardingFacts(
  db: SupabaseClient,
  input: { workspaceId: string; kind: OnboardingSourceKind; id: string },
): Promise<OnboardingFactsResult> {
  const workspaceId = input.workspaceId.trim();
  const ownerUserId = await workspaceOwnerOf(db, workspaceId).catch(() => null);
  if (!ownerUserId) return { ok: false, reason: "unreadable" };
  return input.kind === "application"
    ? applicationFacts(db, workspaceId, ownerUserId, input.id)
    : bookingFacts(db, workspaceId, ownerUserId, input.id);
}

async function applicationFacts(db: SupabaseClient, workspaceId: string, ownerUserId: string, id: string): Promise<OnboardingFactsResult> {
  const { data, error } = await db
    .from("manager_application_records")
    .select("id, resident_email, row_data, manager_user_id")
    .in("id", proplaneIdLookupVariants(id))
    .limit(1)
    .maybeSingle();
  if (error) return { ok: false, reason: "unreadable" };
  if (!data) return { ok: false, reason: "not_found" };
  const record = data as Row;
  // The application belongs to THIS workspace's owner, and its house to this workspace.
  if (str(record.manager_user_id) !== ownerUserId) return { ok: false, reason: "not_found" };
  const row = rec(record.row_data);
  if (str(row.bucket) !== "approved" || str(row.withdrawnAt)) return { ok: false, reason: "not_ready" };
  const application = rec(row.application);
  const propertyId = str(row.assignedPropertyId) || str(row.propertyId) || str(application.propertyId);
  if (!propertyId || !(await propertyBelongsToWorkspace(db, propertyId, workspaceId))) return { ok: false, reason: "not_found" };
  const phoneE164 = normalizeE164(str(application.phone));
  if (!phoneE164) return { ok: false, reason: "no_phone" };
  const house = await houseOf(db, propertyId);
  return {
    ok: true,
    facts: {
      kind: "application",
      id: str(record.id) || id,
      workspaceId,
      ownerUserId,
      propertyId,
      houseLabel: house?.label ?? "",
      roomLabel: str(row.assignedRoomChoice),
      moveInDate: str(application.moveInDate) || str(row.moveInDate),
      fullName: str(application.fullLegalName) || str(row.name),
      email: (str(record.resident_email) || str(row.email) || str(application.email)).toLowerCase(),
      phoneE164,
      phoneKey: normalizeConsentPhone(phoneE164),
      houseRules: house?.rules ?? "",
      residentUserId: str(row.residentUserId) || null,
      smsConsentAt: str(application.smsConsentAt) || null,
    },
  };
}

async function bookingFacts(db: SupabaseClient, workspaceId: string, ownerUserId: string, id: string): Promise<OnboardingFactsResult> {
  const { data, error } = await db.from("portal_schedule_records").select("id, property_id, record_type, row_data").eq("id", id).maybeSingle();
  if (error) return { ok: false, reason: "unreadable" };
  if (!data) return { ok: false, reason: "not_found" };
  const record = data as Row;
  if (str(record.record_type) !== ROOM_DATE_BLOCK_RECORD_TYPE) return { ok: false, reason: "not_found" };
  const propertyId = str(record.property_id);
  if (!propertyId || !(await propertyBelongsToWorkspace(db, propertyId, workspaceId))) return { ok: false, reason: "not_found" };
  const row = rec(record.row_data);
  if (str(row.bookingStatus) !== "confirmed") return { ok: false, reason: "not_ready" };
  const phoneE164 = normalizeE164(str(row.residentPhone));
  if (!phoneE164) return { ok: false, reason: "no_phone" };
  const house = await houseOf(db, propertyId);
  return {
    ok: true,
    facts: {
      kind: "booking",
      id,
      workspaceId,
      ownerUserId,
      propertyId,
      houseLabel: house?.label ?? "",
      roomLabel: str(row.roomLabel),
      moveInDate: str(row.startDate) || str(row.start),
      fullName: str(row.residentName) || str(row.guestName),
      email: str(row.residentEmail).toLowerCase(),
      phoneE164,
      phoneKey: normalizeConsentPhone(phoneE164),
      houseRules: house?.rules ?? "",
      residentUserId: str(row.residentUserId) || null,
      smsConsentAt: null,
    },
  };
}
