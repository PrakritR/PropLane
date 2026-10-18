import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { pacificDayKey } from "@/lib/house-groups/time";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { sendWorkspacePhoneText } from "@/lib/one-number/link-text.server";
import { portalSignInHref } from "@/lib/one-number/link-destinations.server";
import { sendManagerNoticeEmail } from "@/lib/manager-notice-email.server";
import { loadOwnerGrants } from "@/lib/property-owner/access.server";
import { loadManagerReportDisplayContext } from "@/lib/reports/display-context";
import {
  agreementTermsSha256,
  canonicalAgreementTerms,
  describeOwnerFee,
  validateOwnerAgreementTerms,
  type OwnerAgreementTerms,
} from "@/lib/owner-management/fee-math";
import type { OwnerAgreementFacts, OwnerAgreementStatus } from "@/lib/owner-management/routing";

/**
 * Management agreements. Every write re-derives who may do it: the manager comes from the property record
 * (never the request), the owner from an accepted `property_owner` membership that grants that house, and the
 * signer from the authenticated owner. A signed agreement's terms are immutable (the migration trigger backs
 * this up): to change fees, end it and draft a new one.
 */

export type AgreementActor =
  | { role: "admin"; userId: string }
  | { role: "manager"; userId: string };

export type AgreementRow = {
  id: string;
  workspaceId: string | null;
  managerUserId: string;
  propertyId: string;
  ownerUserId: string;
  status: OwnerAgreementStatus;
  terms: OwnerAgreementTerms;
  startsOn: string;
  endsOn: string | null;
  sentAt: string | null;
  signedAt: string | null;
  termsSha256: string | null;
  endedAt: string | null;
  createdAt: string;
};

export class AgreementError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export const AGREEMENT_COLUMNS =
  "id, workspace_id, manager_user_id, property_id, owner_user_id, status, fee_model, fee_bps, fee_flat_cents, leasing_fee_bps, min_fee_cents, reserve_target_cents, repair_approval_threshold_cents, starts_on, ends_on, sent_at, signed_at, terms_sha256, ended_at, created_at";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

export function mapAgreementRow(raw: Row): AgreementRow {
  return {
    id: str(raw.id),
    workspaceId: str(raw.workspace_id) || null,
    managerUserId: str(raw.manager_user_id),
    propertyId: str(raw.property_id),
    ownerUserId: str(raw.owner_user_id),
    status: str(raw.status) as OwnerAgreementStatus,
    terms: {
      feeModel: str(raw.fee_model) === "flat_monthly" ? "flat_monthly" : "percent_of_collected",
      feeBps: int(raw.fee_bps),
      feeFlatCents: int(raw.fee_flat_cents),
      leasingFeeBps: int(raw.leasing_fee_bps),
      minFeeCents: int(raw.min_fee_cents),
      repairApprovalThresholdCents: int(raw.repair_approval_threshold_cents),
      reserveTargetCents: int(raw.reserve_target_cents),
    },
    startsOn: str(raw.starts_on),
    endsOn: str(raw.ends_on) || null,
    sentAt: str(raw.sent_at) || null,
    signedAt: str(raw.signed_at) || null,
    termsSha256: str(raw.terms_sha256) || null,
    endedAt: str(raw.ended_at) || null,
    createdAt: str(raw.created_at),
  };
}

export function agreementFacts(row: AgreementRow): OwnerAgreementFacts {
  return {
    id: row.id,
    propertyId: row.propertyId,
    managerUserId: row.managerUserId,
    ownerUserId: row.ownerUserId,
    status: row.status,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    terms: row.terms,
  };
}

/** The house, read fresh. The manager is the property's own `manager_user_id`, never a request value. */
export async function loadPropertyOwnerOfRecord(
  db: SupabaseClient,
  propertyId: string,
): Promise<{ id: string; managerUserId: string; workspaceId: string | null } | null> {
  const id = propertyId.trim();
  if (!id) return null;
  const { data, error } = await db
    .from("manager_property_records")
    .select("id, manager_user_id, workspace_id")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  const managerUserId = str((data as Row).manager_user_id);
  if (!managerUserId) return null;
  return { id: str((data as Row).id), managerUserId, workspaceId: str((data as Row).workspace_id) || null };
}

/** Only the workspace owner of the house (or a platform admin) manages its agreement. */
export function actorMayManageAgreement(actor: AgreementActor, managerUserId: string): boolean {
  return actor.role === "admin" || actor.userId === managerUserId;
}

/** Does this user hold a live Property owner membership that grants `propertyId` under `managerUserId`? */
export async function ownerHoldsHouse(
  db: SupabaseClient,
  ownerUserId: string,
  managerUserId: string,
  propertyId: string,
): Promise<boolean> {
  const grants = await loadOwnerGrants(db, ownerUserId);
  return grants.some((g) => g.managerUserId === managerUserId && g.houses.some((h) => h.propertyId === propertyId));
}

export type OwnerCandidate = { userId: string; name: string; email: string };

/** The people who can be named as a house's owner: its manager's accepted Property owners granted that house. */
export async function listOwnerCandidates(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string,
): Promise<OwnerCandidate[]> {
  const { data, error } = await db
    .from("account_link_invites")
    .select("invitee_user_id, invitee_display_name")
    .eq("inviter_user_id", managerUserId)
    .eq("status", "accepted")
    .eq("team_role", "property_owner");
  if (error) throw new AgreementError(500, "Could not load owners.");
  const seen = new Set<string>();
  const candidates: OwnerCandidate[] = [];
  for (const row of (data ?? []) as Row[]) {
    const userId = str(row.invitee_user_id);
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    if (!(await ownerHoldsHouse(db, userId, managerUserId, propertyId).catch(() => false))) continue;
    const { data: profile } = await db.from("profiles").select("email, full_name").eq("id", userId).maybeSingle();
    const p = (profile ?? {}) as Row;
    candidates.push({ userId, name: str(row.invitee_display_name) || str(p.full_name) || str(p.email), email: str(p.email) });
  }
  return candidates;
}

export async function loadAgreement(db: SupabaseClient, id: string): Promise<AgreementRow | null> {
  const { data, error } = await db.from("owner_management_agreements").select(AGREEMENT_COLUMNS).eq("id", id.trim()).maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return null;
    throw new AgreementError(500, "Could not load the agreement.");
  }
  return data ? mapAgreementRow(data as Row) : null;
}

/** The newest non-ended agreement for a house (the active one when there is one). Missing tables read as none. */
export async function loadCurrentAgreementForProperty(db: SupabaseClient, propertyId: string): Promise<AgreementRow | null> {
  const { data, error } = await db
    .from("owner_management_agreements")
    .select(AGREEMENT_COLUMNS)
    .eq("property_id", propertyId.trim())
    .in("status", ["active", "draft"])
    .order("status", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(2);
  if (error) {
    if (isMissingSchemaError(error)) return null;
    throw new AgreementError(500, "Could not load the agreement.");
  }
  const rows = ((data ?? []) as Row[]).map(mapAgreementRow);
  return rows.find((r) => r.status === "active") ?? rows[0] ?? null;
}

export type AgreementInput = {
  propertyId: string;
  ownerUserId: string;
  terms: OwnerAgreementTerms;
  startsOn: string;
  endsOn: string | null;
};

function validateDates(startsOn: string, endsOn: string | null): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) throw new AgreementError(400, "Choose a start date.");
  if (endsOn !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(endsOn) || endsOn < startsOn)) {
    throw new AgreementError(400, "The end date must be after the start date.");
  }
}

function columnsFor(input: AgreementInput) {
  return {
    fee_model: input.terms.feeModel,
    fee_bps: input.terms.feeModel === "percent_of_collected" ? input.terms.feeBps : 0,
    fee_flat_cents: input.terms.feeModel === "flat_monthly" ? input.terms.feeFlatCents : 0,
    leasing_fee_bps: input.terms.leasingFeeBps,
    min_fee_cents: input.terms.minFeeCents,
    reserve_target_cents: input.terms.reserveTargetCents,
    repair_approval_threshold_cents: input.terms.repairApprovalThresholdCents,
    starts_on: input.startsOn,
    ends_on: input.endsOn,
  };
}

/** Normalise terms the way they are stored (an unused fee field is zero), then validate. */
export function normalizeTerms(terms: OwnerAgreementTerms): OwnerAgreementTerms {
  return {
    ...terms,
    feeBps: terms.feeModel === "percent_of_collected" ? terms.feeBps : 0,
    feeFlatCents: terms.feeModel === "flat_monthly" ? terms.feeFlatCents : 0,
  };
}

export async function createDraftAgreement(
  db: SupabaseClient,
  actor: AgreementActor,
  rawInput: AgreementInput,
): Promise<AgreementRow> {
  const input: AgreementInput = { ...rawInput, terms: normalizeTerms(rawInput.terms) };
  const problem = validateOwnerAgreementTerms(input.terms);
  if (problem) throw new AgreementError(400, problem);
  validateDates(input.startsOn, input.endsOn);

  const property = await loadPropertyOwnerOfRecord(db, input.propertyId);
  if (!property) throw new AgreementError(404, "House not found.");
  if (!actorMayManageAgreement(actor, property.managerUserId)) throw new AgreementError(403, "Only the workspace owner can set up a management agreement.");
  if (!(await ownerHoldsHouse(db, input.ownerUserId, property.managerUserId, property.id).catch(() => false))) {
    throw new AgreementError(422, "Invite this person as a Property owner of the house first.");
  }
  const existing = await loadCurrentAgreementForProperty(db, property.id);
  if (existing) {
    throw new AgreementError(409, existing.status === "active" ? "This house already has an active agreement. End it first." : "This house already has a draft agreement. Edit or end it.");
  }

  const { data, error } = await db
    .from("owner_management_agreements")
    .insert({
      workspace_id: property.workspaceId,
      manager_user_id: property.managerUserId,
      property_id: property.id,
      owner_user_id: input.ownerUserId,
      status: "draft",
      ...columnsFor(input),
    })
    .select(AGREEMENT_COLUMNS)
    .single();
  if (error || !data) {
    if (String(error?.code) === "23505") throw new AgreementError(409, "This house already has an agreement.");
    throw new AgreementError(500, "Could not save the agreement.");
  }
  return mapAgreementRow(data as Row);
}

export async function updateDraftAgreement(
  db: SupabaseClient,
  actor: AgreementActor,
  id: string,
  patch: Partial<Pick<AgreementInput, "terms" | "startsOn" | "endsOn" | "ownerUserId">>,
): Promise<AgreementRow> {
  const current = await loadAgreement(db, id);
  if (!current) throw new AgreementError(404, "Agreement not found.");
  const property = await loadPropertyOwnerOfRecord(db, current.propertyId);
  if (!property || property.managerUserId !== current.managerUserId) throw new AgreementError(404, "Agreement not found.");
  if (!actorMayManageAgreement(actor, property.managerUserId)) throw new AgreementError(403, "Only the workspace owner can edit this agreement.");
  if (current.status !== "draft") throw new AgreementError(409, "A signed agreement cannot be edited. End it and draft a new one.");

  const next: AgreementInput = {
    propertyId: current.propertyId,
    ownerUserId: patch.ownerUserId ?? current.ownerUserId,
    terms: normalizeTerms(patch.terms ?? current.terms),
    startsOn: patch.startsOn ?? current.startsOn,
    endsOn: patch.endsOn === undefined ? current.endsOn : patch.endsOn,
  };
  const problem = validateOwnerAgreementTerms(next.terms);
  if (problem) throw new AgreementError(400, problem);
  validateDates(next.startsOn, next.endsOn);
  if (next.ownerUserId !== current.ownerUserId &&
      !(await ownerHoldsHouse(db, next.ownerUserId, property.managerUserId, property.id).catch(() => false))) {
    throw new AgreementError(422, "Invite this person as a Property owner of the house first.");
  }
  const { data, error } = await db
    .from("owner_management_agreements")
    .update({ ...columnsFor(next), owner_user_id: next.ownerUserId, sent_at: null, updated_at: new Date().toISOString() })
    .eq("id", current.id)
    .eq("status", "draft")
    .select(AGREEMENT_COLUMNS)
    .maybeSingle();
  if (error || !data) throw new AgreementError(409, "The agreement changed. Reload and try again.");
  return mapAgreementRow(data as Row);
}

const SEND_COOLDOWN_MS = 60 * 60 * 1000;

/** Text and email the owner a sign-in link to the agreement. Marks `sent_at`; re-sending is allowed once an hour. */
export async function sendAgreementForSignature(
  db: SupabaseClient,
  actor: AgreementActor,
  id: string,
  now: Date = new Date(),
): Promise<{ agreement: AgreementRow; emailed: boolean; texted: boolean }> {
  const current = await loadAgreement(db, id);
  if (!current) throw new AgreementError(404, "Agreement not found.");
  const property = await loadPropertyOwnerOfRecord(db, current.propertyId);
  if (!property || property.managerUserId !== current.managerUserId) throw new AgreementError(404, "Agreement not found.");
  if (!actorMayManageAgreement(actor, property.managerUserId)) throw new AgreementError(403, "Only the workspace owner can send this agreement.");
  if (current.status !== "draft") throw new AgreementError(409, "Only a draft can be sent for signature.");
  if (current.sentAt && now.getTime() - Date.parse(current.sentAt) < SEND_COOLDOWN_MS) {
    throw new AgreementError(429, "Already sent. You can send it again in an hour.");
  }
  const problem = validateOwnerAgreementTerms(current.terms);
  if (problem) throw new AgreementError(400, problem);
  if (!(await ownerHoldsHouse(db, current.ownerUserId, property.managerUserId, property.id).catch(() => false))) {
    throw new AgreementError(422, "This person is no longer a Property owner of the house.");
  }

  const { data, error } = await db
    .from("owner_management_agreements")
    .update({ sent_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("id", current.id)
    .eq("status", "draft")
    .select(AGREEMENT_COLUMNS)
    .maybeSingle();
  if (error || !data) throw new AgreementError(409, "The agreement changed. Reload and try again.");
  const agreement = mapAgreementRow(data as Row);

  const display = await loadManagerReportDisplayContext(db, property.managerUserId).catch(() => null);
  const house = display?.propertyLabel(property.id) || "your house";
  const path = `/portal/owner/agreements/${agreement.id}`;
  const link = `${resolveEmailLinkBaseUrl()}${portalSignInHref(path)}`;
  const feeLine = describeOwnerFee(agreement.terms);
  const stamp = now.toISOString().slice(0, 13); // one notice per hour, matching the cooldown

  const email = await sendManagerNoticeEmail(db, {
    recipientUserId: agreement.ownerUserId,
    ownerUserId: property.managerUserId,
    workspaceId: property.workspaceId,
    subject: `Management agreement for ${house}`,
    text: `Your management agreement for ${house} is ready to review and sign.\nFee: ${feeLine}.`,
    url: portalSignInHref(path),
    idempotencyKey: `owner-agreement-sent:${agreement.id}:${stamp}`,
  }).catch(() => ({ status: "failed" as const }));

  let texted = false;
  if (property.workspaceId) {
    const { data: profile } = await db.from("profiles").select("phone, phone_verified_at").eq("id", agreement.ownerUserId).maybeSingle();
    const p = (profile ?? {}) as Row;
    if (str(p.phone) && p.phone_verified_at) {
      texted = await sendWorkspacePhoneText(db, {
        workspaceId: property.workspaceId,
        phoneKey: str(p.phone),
        body: `Your management agreement for ${house} is ready to sign: ${link}`,
        role: "manager",
        idempotencyKey: `owner-agreement-sent:${agreement.id}:${stamp}`,
      }).catch(() => false);
    }
  }
  return { agreement, emailed: email.status === "sent", texted };
}

/**
 * The owner signs. Identity is the authenticated owner, the membership is read fresh, and the hash is of
 * the exact terms stored at this instant (the row is a draft, and a draft's terms are unchangeable after
 * the conditional update below succeeds).
 */
export async function signAgreement(db: SupabaseClient, ownerUserId: string, id: string, now: Date = new Date()): Promise<AgreementRow> {
  const current = await loadAgreement(db, id);
  if (!current || current.ownerUserId !== ownerUserId) throw new AgreementError(404, "Agreement not found.");
  if (current.status === "active" && current.signedAt) return current; // idempotent replay
  if (current.status !== "draft" || !current.sentAt) throw new AgreementError(409, "This agreement is not waiting for your signature.");
  const today = pacificDayKey(now);
  if (current.endsOn && current.endsOn < today) throw new AgreementError(409, "This agreement has already ended.");
  if (!(await ownerHoldsHouse(db, ownerUserId, current.managerUserId, current.propertyId).catch(() => false))) {
    throw new AgreementError(403, "You no longer have access to this house.");
  }
  const property = await loadPropertyOwnerOfRecord(db, current.propertyId);
  if (!property || property.managerUserId !== current.managerUserId) throw new AgreementError(404, "Agreement not found.");

  const canonical = canonicalAgreementTerms({
    propertyId: current.propertyId,
    ownerUserId: current.ownerUserId,
    terms: current.terms,
    startsOn: current.startsOn,
    endsOn: current.endsOn,
  });
  const hash = agreementTermsSha256(canonical);
  const { data, error } = await db
    .from("owner_management_agreements")
    .update({
      status: "active",
      signed_at: now.toISOString(),
      terms_sha256: hash,
      terms_snapshot: JSON.parse(canonical) as Record<string, unknown>,
      updated_at: now.toISOString(),
    })
    // The conditions are the authorization: still a draft, still this owner, still the sent version.
    .eq("id", current.id)
    .eq("status", "draft")
    .eq("owner_user_id", ownerUserId)
    .eq("manager_user_id", current.managerUserId)
    .not("sent_at", "is", null)
    .select(AGREEMENT_COLUMNS)
    .maybeSingle();
  if (error) {
    if (String(error.code) === "23505") throw new AgreementError(409, "Another agreement is already active for this house.");
    throw new AgreementError(500, "Could not record your signature.");
  }
  if (!data) throw new AgreementError(409, "The agreement changed. Reload and review it again.");
  return mapAgreementRow(data as Row);
}

/** End a draft (deleted from view) or an active agreement (routing stops for new charges today). */
export async function endAgreement(db: SupabaseClient, actor: AgreementActor, id: string, now: Date = new Date()): Promise<AgreementRow> {
  const current = await loadAgreement(db, id);
  if (!current) throw new AgreementError(404, "Agreement not found.");
  const property = await loadPropertyOwnerOfRecord(db, current.propertyId);
  if (!property || property.managerUserId !== current.managerUserId) throw new AgreementError(404, "Agreement not found.");
  if (!actorMayManageAgreement(actor, property.managerUserId)) throw new AgreementError(403, "Only the workspace owner can end this agreement.");
  if (current.status === "ended") return current;
  const today = pacificDayKey(now);
  const { data, error } = await db
    .from("owner_management_agreements")
    .update({
      status: "ended",
      ended_at: now.toISOString(),
      ended_by_role: actor.role,
      ends_on: current.endsOn && current.endsOn < today ? current.endsOn : today >= current.startsOn ? today : current.startsOn,
      updated_at: now.toISOString(),
    })
    .eq("id", current.id)
    .in("status", ["draft", "active"])
    .select(AGREEMENT_COLUMNS)
    .maybeSingle();
  if (error || !data) throw new AgreementError(409, "The agreement changed. Reload and try again.");
  return mapAgreementRow(data as Row);
}

/** The owner's own preference: how large a repair needs their yes. Allowed after signing (not a fee term). */
export async function setOwnerRepairThreshold(
  db: SupabaseClient,
  ownerUserId: string,
  id: string,
  cents: number,
): Promise<AgreementRow> {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 5_000_000) throw new AgreementError(400, "Enter an amount between $0 and $50,000.");
  const current = await loadAgreement(db, id);
  if (!current || current.ownerUserId !== ownerUserId) throw new AgreementError(404, "Agreement not found.");
  if (current.status === "ended") throw new AgreementError(409, "This agreement has ended.");
  const { data, error } = await db
    .from("owner_management_agreements")
    .update({ repair_approval_threshold_cents: cents, updated_at: new Date().toISOString() })
    .eq("id", current.id)
    .eq("owner_user_id", ownerUserId)
    .in("status", ["draft", "active"])
    .select(AGREEMENT_COLUMNS)
    .maybeSingle();
  if (error || !data) throw new AgreementError(409, "The agreement changed. Reload and try again.");
  return mapAgreementRow(data as Row);
}

/** Agreements an owner can see: their own, with the house label. Never anyone else's. */
export async function listAgreementsForOwner(
  db: SupabaseClient,
  ownerUserId: string,
): Promise<Array<AgreementRow & { houseLabel: string; feeLine: string }>> {
  const { data, error } = await db
    .from("owner_management_agreements")
    .select(AGREEMENT_COLUMNS)
    .eq("owner_user_id", ownerUserId)
    .in("status", ["draft", "active", "ended"])
    .not("sent_at", "is", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw new AgreementError(500, "Could not load agreements.");
  }
  const rows = ((data ?? []) as Row[]).map(mapAgreementRow);
  const out: Array<AgreementRow & { houseLabel: string; feeLine: string }> = [];
  for (const row of rows) {
    // The membership is read fresh: a revoked owner sees nothing.
    if (!(await ownerHoldsHouse(db, ownerUserId, row.managerUserId, row.propertyId).catch(() => false))) continue;
    const display = await loadManagerReportDisplayContext(db, row.managerUserId).catch(() => null);
    out.push({ ...row, houseLabel: display?.propertyLabel(row.propertyId) || "Your house", feeLine: describeOwnerFee(row.terms) });
  }
  return out;
}
