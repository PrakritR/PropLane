import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";
import { buildManagerApplyUrl, buildManagerListingUrl } from "@/lib/manager-property-links";
import type { PhoneBoundLink } from "@/lib/one-number/links.server";
import { revokePhoneBoundLinksForTarget } from "@/lib/one-number/links.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { createServiceShareLink } from "@/lib/service-share-links.server";
import { buildServiceShareUrl } from "@/lib/service-share-links.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";

/**
 * Where a verified (or no-code) phone-bound link leads. The link row names a target, never a URL:
 * the destination is built here, from the live record, and every record is re-checked against the
 * link's workspace and phone before the page says anything about it. Anything that does not check
 * out is `gone`, which the page renders as the same "This link has expired" view as a dead token.
 */
export type RentChargeView = { id: string; title: string; amountLabel: string; propertyLabel: string };

export type LinkDestination =
  /** A public page that needs no account. */
  | { kind: "redirect"; href: string }
  /** A page inside the signed-in portal (identity and money setup live there). */
  | { kind: "portal"; href: string }
  /** The rent page: charges the resident can pay by card from here. */
  | { kind: "rent"; chargeIds: string[]; charges: RentChargeView[]; residentUserId: string; residentEmail: string }
  /** Everything linked here is already paid. */
  | { kind: "paid" }
  /** Nothing is payable from here YET: a bank debit is still clearing and may still fail. */
  | { kind: "processing" }
  | { kind: "gone" };

const GONE: LinkDestination = { kind: "gone" };

/** Same cap as the checkout core (`MAX_BULK_CHARGES`), which enforces it again. */
const MAX_LINKED_CHARGES = 10;

type Row = Record<string, unknown>;
const str = (value: unknown): string => (typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim());

/** Sign in, then continue to `path`: the sign-in page takes the same-site `next` path. */
export function portalSignInHref(path: string): string {
  return `/auth/sign-in?next=${encodeURIComponent(path)}`;
}

async function workspaceOwner(db: SupabaseClient, workspaceId: string | null): Promise<string | null> {
  if (!workspaceId) return null;
  const { data, error } = await db.from("portal_workspaces").select("owner_user_id").eq("id", workspaceId).maybeSingle();
  if (error || !data) return null;
  return str((data as Row).owner_user_id) || null;
}

/**
 * Does this house belong to this workspace? The house names its workspace; a house with none
 * belongs to its manager's default workspace, which is the workspace owner's.
 */
export async function propertyBelongsToWorkspace(
  db: SupabaseClient,
  propertyId: string,
  workspaceId: string | null,
): Promise<boolean> {
  if (!propertyId || !workspaceId) return false;
  const { data, error } = await db
    .from("manager_property_records")
    .select("id, workspace_id, manager_user_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (error || !data) return false;
  const row = data as Row;
  const houseWorkspace = str(row.workspace_id);
  if (houseWorkspace) return houseWorkspace === workspaceId;
  const owner = await workspaceOwner(db, workspaceId);
  return Boolean(owner) && str(row.manager_user_id) === owner;
}

/**
 * The workspace a house belongs to: the house's own, else its manager's default workspace.
 * Null when neither can be read (the caller then mints nothing).
 */
export async function resolveWorkspaceForProperty(
  db: SupabaseClient,
  propertyId: string | null,
  ownerUserId: string,
): Promise<string | null> {
  if (propertyId) {
    const { data } = await db.from("manager_property_records").select("workspace_id").eq("id", propertyId).maybeSingle();
    const own = str((data as Row | null)?.workspace_id);
    if (own) return own;
  }
  if (!ownerUserId) return null;
  const { data } = await db
    .from("portal_workspaces")
    .select("id")
    .eq("owner_user_id", ownerUserId)
    .eq("is_default", true)
    .maybeSingle();
  return str((data as Row | null)?.id) || null;
}

/** A work-order row that is finished, cancelled or marked done by the vendor. */
export function workOrderJobClosed(rowData: unknown): boolean {
  const data = (rowData && typeof rowData === "object" ? rowData : {}) as Row;
  const bucket = str(data.bucket).toLowerCase();
  if (["completed", "cancelled", "canceled", "closed"].includes(bucket)) return true;
  return str(data.automationStatus).toLowerCase() === "vendor_marked_done";
}

async function jobDestination(db: SupabaseClient, link: PhoneBoundLink): Promise<LinkDestination> {
  const { data, error } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, property_id, assigned_property_id, row_data")
    .eq("id", link.targetId)
    .maybeSingle();
  if (error || !data) return GONE;
  const row = data as Row;
  if (workOrderJobClosed(row.row_data)) {
    // The job closed: every link to it closes with it.
    await revokePhoneBoundLinksForTarget(db, { targetType: link.targetType, targetId: link.targetId, purpose: "job" }).catch(() => 0);
    return GONE;
  }
  const managerUserId = str(row.manager_user_id);
  const propertyId = str(row.assigned_property_id) || str(row.property_id);
  const owner = await workspaceOwner(db, link.workspaceId);
  const inWorkspace = propertyId
    ? await propertyBelongsToWorkspace(db, propertyId, link.workspaceId)
    : Boolean(owner) && managerUserId === owner;
  if (!managerUserId || !inWorkspace) return GONE;

  const phone = normalizeE164(link.phoneKey);
  if (!phone) return GONE;
  // The vendor's job view is the existing hashed-token service page, bound to this phone. One live
  // link per phone per job: opening again replaces the previous one instead of stacking them.
  await db
    .from("service_share_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("work_order_id", link.targetId)
    .eq("recipient_phone", phone)
    .is("revoked_at", null);
  try {
    const { token } = await createServiceShareLink(db, {
      workOrderId: link.targetId,
      managerUserId,
      createdBy: link.createdBy || managerUserId,
      recipientPhone: phone,
      sharePhotos: false,
    });
    return { kind: "redirect", href: buildServiceShareUrl("", token) };
  } catch {
    return GONE;
  }
}

async function rentDestination(db: SupabaseClient, link: PhoneBoundLink): Promise<LinkDestination> {
  const ids = [...new Set(link.targetId.split(",").map((id) => id.trim()).filter(Boolean))].slice(0, MAX_LINKED_CHARGES);
  if (ids.length === 0) return GONE;
  const charges: RentChargeView[] = [];
  let paid = 0;
  let processing = 0;
  let residentUserId = "";
  let residentEmail = "";
  for (const id of ids) {
    const { data, error } = await db
      .from("portal_household_charge_records")
      .select("id, row_data, status")
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return GONE;
    const charge = (data as Row).row_data as HouseholdCharge | null;
    if (!charge?.id) return GONE;
    // The charge must belong to the workspace the link was issued from, and to the person whose
    // phone this is: a link for one resident's rent never opens another's.
    if (!(await propertyBelongsToWorkspace(db, str(charge.propertyId), link.workspaceId))) return GONE;
    const owner = str(charge.residentUserId);
    if (!owner || (residentUserId && owner !== residentUserId)) return GONE;
    residentUserId = owner;
    residentEmail = str(charge.residentEmail).toLowerCase();
    const status = str((data as Row).status) || str(charge.status);
    // Paid, or a bank debit already clearing: nothing left to pay from here. They are NOT the same answer: a
    // debit in `processing` can still fail and become payable again, so the link must not be burned for it.
    if (status === "paid") {
      paid += 1;
      continue;
    }
    if (status === "processing") {
      processing += 1;
      continue;
    }
    // Only a charge the checkout core would accept is payable; cancelled, refunded or part-paid is not.
    if (status !== "pending" && status !== "failed") return GONE;
    charges.push({
      id,
      title: str(charge.title) || "Rent",
      amountLabel: str(charge.balanceLabel) || str(charge.amountLabel),
      propertyLabel: str(charge.propertyLabel),
    });
  }
  if (!(await residentPhoneMatches(db, residentUserId, link.phoneKey))) return GONE;
  if (charges.length === 0 && processing > 0) return { kind: "processing" };
  if (charges.length === 0 && paid > 0) return { kind: "paid" };
  if (charges.length === 0) return GONE;
  return { kind: "rent", chargeIds: charges.map((c) => c.id), charges, residentUserId, residentEmail };
}

/** The resident account holds this phone. An account with no phone on file cannot vouch for one. */
export async function residentPhoneMatches(db: SupabaseClient, residentUserId: string, phoneKey: string): Promise<boolean> {
  const { data, error } = await db.from("profiles").select("phone").eq("id", residentUserId).maybeSingle();
  if (error || !data) return false;
  const onFile = normalizeConsentPhone(str((data as Row).phone));
  return /^\d{10}$/.test(onFile) && onFile === phoneKey;
}

/**
 * Resolve a link's destination. Call it only after the link is open (a no-code link, or a code
 * that was just proven): nothing here is safe to show before that.
 */
export async function resolveLinkDestination(db: SupabaseClient, link: PhoneBoundLink): Promise<LinkDestination> {
  switch (link.purpose) {
    case "gallery":
    case "tour":
    case "application": {
      if (link.targetType !== "listing") return GONE;
      if (!(await propertyBelongsToWorkspace(db, link.targetId, link.workspaceId))) return GONE;
      if (link.purpose === "gallery") return { kind: "redirect", href: buildManagerListingUrl("", link.targetId) };
      if (link.purpose === "tour") {
        return { kind: "redirect", href: `/rent/tours-contact?propertyId=${encodeURIComponent(link.targetId)}` };
      }
      // The apply form already knows the phone, so the person is never asked for it again.
      return { kind: "redirect", href: buildManagerApplyUrl("", { propertyId: link.targetId, phone: link.phoneKey }) };
    }
    case "lease":
      return { kind: "portal", href: portalSignInHref("/resident/lease") };
    case "move_in":
      return { kind: "portal", href: portalSignInHref("/resident/move-in") };
    case "payouts":
      return {
        kind: "portal",
        href: portalSignInHref(link.targetType === "vendor" ? "/vendor/financials/payouts" : "/portal/financials"),
      };
    case "rent":
      return rentDestination(db, link);
    case "job":
      return link.targetType === "work_order" ? jobDestination(db, link) : GONE;
    default:
      return GONE;
  }
}
