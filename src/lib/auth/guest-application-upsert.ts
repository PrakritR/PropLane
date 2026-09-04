import type { DemoApplicantRow } from "@/data/demo-portal";
import { attachResidentSetupToken, isResidentSetupTokenValid } from "@/lib/auth/resident-setup-token";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import type { SupabaseClient } from "@supabase/supabase-js";

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export type GuestApplicationUpsertResult =
  | { ok: true; row: DemoApplicantRow; setupToken: string }
  | { ok: false; status: number; error: string };

export function isValidGuestApplicationEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim().toLowerCase());
}

/** The message an applicant sees when a listing is no longer taking applications. */
export const LISTING_NOT_ACCEPTING_APPLICATIONS_ERROR =
  "This home is no longer accepting applications. Browse other homes to find one that is.";

/**
 * Only a LIVE listing accepts applications.
 *
 * `manager_property_records.status` is one of pending / live / review /
 * request_change / unlisted / rejected / draft. A manager unpublishes for real
 * reasons — the unit is rented, the listing was wrong, the property is
 * off-market — and applications continuing to arrive undermines the one control
 * they have. It also bills the applicant for a home that is not available,
 * which is a refund conversation the product created.
 */
export function propertyStatusAcceptsApplications(status: string | null | undefined): boolean {
  return (status ?? "").trim() === "live";
}

export type PropertyApplicationTarget = {
  managerUserId: string | null;
  status: string | null;
  /** Whether a NEW application may be submitted against this listing right now. */
  acceptsApplications: boolean;
};

/**
 * The manager a listing belongs to, and whether it is still taking
 * applications — the single server-side source of application attribution,
 * shared by the guest and signed-in-resident submit paths. Reads the record's
 * `manager_user_id` first, then the legacy `property_data.managerUserId`.
 */
export async function resolvePropertyApplicationTarget(
  db: SupabaseClient,
  propertyId: string,
): Promise<PropertyApplicationTarget> {
  const trimmed = propertyId.trim();
  if (!trimmed) return { managerUserId: null, status: null, acceptsApplications: false };

  const { data: propertyRecord } = await db
    .from("manager_property_records")
    .select("manager_user_id, status, property_data")
    .eq("id", trimmed)
    .maybeSingle();

  const direct = typeof propertyRecord?.manager_user_id === "string" ? propertyRecord.manager_user_id.trim() : "";
  const propertyData =
    propertyRecord?.property_data && typeof propertyRecord.property_data === "object" && !Array.isArray(propertyRecord.property_data)
      ? (propertyRecord.property_data as Record<string, unknown>)
      : null;
  const fromData = typeof propertyData?.managerUserId === "string" ? propertyData.managerUserId.trim() : "";
  const status = typeof propertyRecord?.status === "string" ? propertyRecord.status : null;

  return {
    managerUserId: direct || fromData || null,
    status,
    // An unknown listing accepts nothing: fail closed rather than treating a
    // missing row as permissive.
    acceptsApplications: Boolean(propertyRecord) && propertyStatusAcceptsApplications(status),
  };
}

/** Attribution only. Prefer {@link resolvePropertyApplicationTarget} on a submit path. */
export async function resolveManagerUserIdForProperty(
  db: SupabaseClient,
  propertyId: string,
): Promise<string | null> {
  return (await resolvePropertyApplicationTarget(db, propertyId)).managerUserId;
}

/**
 * Authorize and prepare a guest (unauthenticated) application upsert.
 * Guests may only write pending rows for their own email, scoped to a listing's manager.
 */
export async function prepareGuestApplicationUpsert(
  db: SupabaseClient,
  params: {
    row: DemoApplicantRow;
    existing?: DemoApplicantRow | null;
    /** When the browser still holds the row's current setup token, keep it so emailed resume links stay valid. */
    clientSetupToken?: string | null;
  },
): Promise<GuestApplicationUpsertResult> {
  const email = (params.row.email ?? "").trim().toLowerCase();
  if (!isValidGuestApplicationEmail(email)) {
    return { ok: false, status: 400, error: "A valid email is required to submit without an account." };
  }

  if (params.row.bucket !== "pending") {
    return { ok: false, status: 403, error: "Guests can only submit pending applications." };
  }

  if (params.existing && params.existing.bucket !== "pending") {
    return { ok: false, status: 403, error: "This application can no longer be edited." };
  }

  const existingEmail = (params.existing?.email ?? "").trim().toLowerCase();
  if (params.existing && existingEmail && existingEmail !== email) {
    return { ok: false, status: 403, error: "You can only update your own application." };
  }

  const propertyId =
    params.row.propertyId?.trim() ||
    params.row.assignedPropertyId?.trim() ||
    params.row.application?.propertyId?.trim() ||
    "";
  if (!propertyId) {
    return { ok: false, status: 400, error: "A property is required to submit an application." };
  }

  const target = await resolvePropertyApplicationTarget(db, propertyId);
  const managerUserId = target.managerUserId || params.existing?.managerUserId?.trim() || null;

  if (!managerUserId) {
    return { ok: false, status: 400, error: "This listing cannot accept applications yet." };
  }

  // A listing taken down stops accepting NEW applications. An application
  // already in flight (`params.existing`) may still be saved and completed —
  // refusing mid-wizard would strand work the applicant has already done, and
  // this path handles progressive saves as well as the final submit.
  if (!params.existing && !target.acceptsApplications) {
    return { ok: false, status: 409, error: LISTING_NOT_ACCEPTING_APPLICATIONS_ERROR };
  }

  const baseRow: DemoApplicantRow = {
    ...params.row,
    id: normalizeApplicationAxisId(params.row.id),
    email,
    bucket: "pending",
    propertyId,
    managerUserId,
    // Guests cannot escalate manager-controlled fields.
    withdrawnAt: params.existing?.withdrawnAt ?? params.row.withdrawnAt,
    assignedPropertyId: params.existing?.assignedPropertyId ?? params.row.assignedPropertyId,
    assignedRoomChoice: params.existing?.assignedRoomChoice ?? params.row.assignedRoomChoice,
    signedMonthlyRent: params.existing?.signedMonthlyRent ?? params.row.signedMonthlyRent,
    backgroundCheckStatus: params.existing?.backgroundCheckStatus ?? params.row.backgroundCheckStatus,
    screening: params.existing?.screening ?? params.row.screening,
    manuallyAdded: params.existing?.manuallyAdded ?? params.row.manuallyAdded,
    moveInInstructions: params.existing?.moveInInstructions ?? params.row.moveInInstructions,
    application:
      params.row.application && params.existing?.application
        ? {
            ...params.row.application,
            managerRentOverride: params.existing.application.managerRentOverride,
            managerUtilitiesOverride: params.existing.application.managerUtilitiesOverride,
            managerSecurityDepositOverride: params.existing.application.managerSecurityDepositOverride,
            managerMoveInFeeOverride: params.existing.application.managerMoveInFeeOverride,
            managerOtherCostLabel: params.existing.application.managerOtherCostLabel,
            managerOtherCostAmount: params.existing.application.managerOtherCostAmount,
          }
        : params.row.application,
  };

  const clientToken = params.clientSetupToken?.trim();
  if (params.existing && clientToken && isResidentSetupTokenValid(params.existing, clientToken)) {
    return {
      ok: true,
      row: {
        ...baseRow,
        setupTokenHash: params.existing.setupTokenHash,
        setupTokenExpiresAt: params.existing.setupTokenExpiresAt,
        setupTokenConsumedAt: params.existing.setupTokenConsumedAt,
      },
      setupToken: clientToken,
    };
  }

  const { row, token } = attachResidentSetupToken(baseRow);
  return { ok: true, row, setupToken: token };
}
