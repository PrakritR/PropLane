import { buildPortfolioApplyHref } from "@/lib/manager-property-links";
import { residentCreateAccountHref, residentSignInHref } from "@/lib/resident-public-nav";
import { residentPortalApplyReturnPath } from "@/lib/rental-application/public-apply-session";

export type ProspectActionKind = "apply" | "tour" | "message" | "lease";

/** Session key for an account gate — action + property (apply keeps legacy bare-id keys). */
export function prospectGateKey(kind: ProspectActionKind, propertyId: string): string {
  const pid = propertyId.trim();
  if (!pid) return "";
  return kind === "apply" ? pid : `${kind}:${pid}`;
}

/**
 * A resident account is required for every prospect action (PLAN-0924-1421) —
 * there is no guest path left to remember. Kept as a stub so a stale session key
 * written before the gate closed cannot reopen it.
 *
 * @deprecated Always false. Do not reintroduce a guest bypass.
 */
export function hasProspectGuestContinue(gateKey: string): boolean {
  void gateKey;
  return false;
}

export function prospectPortalReturnPath(
  kind: ProspectActionKind,
  input: { propertyId: string; rentalType?: "standard" | "short_term"; listingRoomId?: string; bundleId?: string },
): string {
  const pid = input.propertyId.trim();
  if (kind === "lease") return "/resident/lease";
  if (!pid) {
    return kind === "apply"
      ? "/resident/applications/apply"
      : kind === "tour"
        ? "/resident/tour/schedule"
        : "/resident/communication/active";
  }
  if (kind === "apply") {
    return residentPortalApplyReturnPath({
      propertyId: pid,
      rentalType: input.rentalType,
      listingRoomId: input.listingRoomId,
      bundleId: input.bundleId,
    });
  }
  if (kind === "tour") {
    return `/resident/tour/schedule?propertyId=${encodeURIComponent(pid)}`;
  }
  return `/resident/communication/active?propertyId=${encodeURIComponent(pid)}&compose=1`;
}

export function prospectPublicReturnPath(
  kind: ProspectActionKind,
  input: {
    propertyId: string;
    portfolioPropertyIds?: readonly string[];
    rentalType?: "standard" | "short_term";
    listingRoomId?: string;
    bundleId?: string;
  },
): string {
  const pid = input.propertyId.trim();
  // A lease only exists inside the resident portal — there is no public surface
  // to bounce a signer back to.
  if (kind === "lease") return "/resident/lease";
  if (kind === "apply") {
    if (pid) {
      const q = new URLSearchParams({ propertyId: pid });
      if (input.rentalType === "short_term") q.set("rentalType", "short_term");
      if (input.listingRoomId?.trim()) q.set("listingRoomId", input.listingRoomId.trim());
      if (input.bundleId?.trim()) q.set("bundle", input.bundleId.trim());
      return `/rent/apply?${q.toString()}`;
    }
    const ids = [...new Set((input.portfolioPropertyIds ?? []).map((id) => id.trim()).filter(Boolean))].sort();
    if (ids.length > 0) {
      return buildPortfolioApplyHref(ids, {
        rentalType: input.rentalType === "short_term" ? "short_term" : undefined,
      });
    }
    return "/rent/apply";
  }
  if (kind === "tour") {
    return pid ? `/rent/tours-contact?propertyId=${encodeURIComponent(pid)}` : "/rent/tours-contact";
  }
  const q = new URLSearchParams({ tab: "message" });
  if (pid) q.set("propertyId", pid);
  return `/rent/tours-contact?${q.toString()}`;
}

export function prospectCreateAccountHref(
  kind: ProspectActionKind,
  gateKey: string,
  returnPath: string,
  opts?: { email?: string; fullName?: string; phone?: string; tourInquiryId?: string },
): string {
  const next = returnPath.trim() || prospectPortalReturnPath(kind, { propertyId: gateKey.replace(/^(tour|message|lease):/, "") });
  if (kind === "message") {
    return residentCreateAccountHref(next, {
      email: opts?.email,
      fullName: opts?.fullName,
      phone: opts?.phone,
      handoff: "message",
    });
  }
  if (kind === "tour" && opts?.tourInquiryId) {
    return residentCreateAccountHref(next, {
      email: opts?.email,
      fullName: opts?.fullName,
      phone: opts?.phone,
      tourInquiryId: opts.tourInquiryId,
    });
  }
  return residentCreateAccountHref(next, {
    email: opts?.email,
    fullName: opts?.fullName,
    phone: opts?.phone,
  });
}

export function prospectSignInHref(
  kind: ProspectActionKind,
  gateKey: string,
  returnPath: string,
  opts?: { email?: string; fullName?: string; phone?: string; tourInquiryId?: string },
): string {
  const next = returnPath.trim() || prospectPortalReturnPath(kind, { propertyId: gateKey.replace(/^(tour|message|lease):/, "") });
  return residentSignInHref(next, {
    tourInquiryId: opts?.tourInquiryId,
    email: opts?.email,
    fullName: opts?.fullName,
    phone: opts?.phone,
    ...(kind === "message" ? { handoff: "message" as const } : {}),
  });
}

export type ProspectGateView = "account-prompt" | "signed-in-create-resident" | "resident-portal" | "action";

/**
 * A resident account is required (PLAN-0924-1421): once a gate key is in play,
 * the only way past this gate is holding the resident role.
 */
export function resolveProspectGateView(input: {
  gateKey?: string;
  /** @deprecated Ignored — guest continue is gone. */
  guestContinue?: boolean;
  signedInNonResident: boolean;
  hasResidentRole?: boolean;
}): ProspectGateView {
  const key = input.gateKey?.trim() ?? "";
  if (input.hasResidentRole) return "resident-portal";
  if (!key) return "action";
  return input.signedInNonResident ? "signed-in-create-resident" : "account-prompt";
}
