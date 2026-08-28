/**
 * Client fetcher for the SERVER-authoritative application-fee itemization
 * (`POST /api/public/application-fee-preview` → `resolveApplicationFeeProperty`
 * → `effectiveApplicationFeeCents`, which consults the manager-level fee).
 *
 * This is the money-path source of truth the apply wizard must derive its
 * gate (needsFee), displayed amount, AND booked charge from — the per-listing
 * `applicationFee` the browser catalog carries is only the grandfathered
 * fallback and can disagree with what checkout actually charges. Cached per
 * (propertyId, managerUserId) with a TTL + in-flight guard (the shared
 * client-sync pattern) so the wizard's several consumers share one request.
 */

import type { ApplicationFeeChargePolicy } from "@/lib/manager-application-settings";

export type ApplicationFeePreview = {
  applicationFeeCents: number;
  serviceFeeCents: number;
  totalCents: number;
  chargePolicy?: ApplicationFeeChargePolicy;
  repeatApplicantFeeWaived?: boolean;
  applicationFeeOtherEnabled?: boolean;
  applicationFeeOtherInstructions?: string;
};

const PREVIEW_TTL_MS = 60_000;

const cache = new Map<string, { at: number; value: ApplicationFeePreview }>();
const inFlight = new Map<string, Promise<ApplicationFeePreview | null>>();

function keyFor(propertyId: string, managerUserId: string): string {
  return `${propertyId.trim()}::${managerUserId.trim()}`;
}

/**
 * Resolves the server's effective application fee for one listing, or `null`
 * when the server could not answer (network failure, unowned property, …).
 * Callers must treat `null` as "unknown — do not claim no fee is required",
 * never as free.
 */
export async function fetchApplicationFeePreview(input: {
  propertyId: string;
  managerUserId: string;
  rentalType?: "standard" | "short_term";
  /**
   * Only the signed-in caller's own address earns a repeat-applicant waiver —
   * the route ignores it for anyone else and resolves the resident id from the
   * session, never from the browser.
   */
  residentEmail?: string;
}): Promise<ApplicationFeePreview | null> {
  const propertyId = input.propertyId.trim();
  const managerUserId = input.managerUserId.trim();
  if (!propertyId || !managerUserId) return null;

  const rentalType = input.rentalType === "short_term" ? "short_term" : "standard";
  const residentEmail = input.residentEmail?.trim() ?? "";
  const residentKey = residentEmail.includes("@") ? `::${residentEmail.toLowerCase()}` : "";
  const key = `${keyFor(propertyId, managerUserId)}::${rentalType}${residentKey}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < PREVIEW_TTL_MS) return hit.value;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = (async (): Promise<ApplicationFeePreview | null> => {
    try {
      const res = await fetch("/api/public/application-fee-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyId,
          managerUserId,
          rentalType: rentalType === "short_term" ? "short_term" : undefined,
          residentEmail: residentEmail.includes("@") ? residentEmail : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        applicationFeeCents?: number;
        serviceFeeCents?: number;
        totalCents?: number;
        chargePolicy?: ApplicationFeeChargePolicy;
        repeatApplicantFeeWaived?: boolean;
        applicationFeeOtherEnabled?: boolean;
        applicationFeeOtherInstructions?: string;
      };
      if (!res.ok || typeof data.applicationFeeCents !== "number") return null;
      const value: ApplicationFeePreview = {
        applicationFeeCents: data.applicationFeeCents,
        serviceFeeCents: typeof data.serviceFeeCents === "number" ? data.serviceFeeCents : 0,
        totalCents: typeof data.totalCents === "number" ? data.totalCents : data.applicationFeeCents,
        chargePolicy: data.chargePolicy,
        repeatApplicantFeeWaived: data.repeatApplicantFeeWaived,
        applicationFeeOtherEnabled: data.applicationFeeOtherEnabled,
        applicationFeeOtherInstructions: data.applicationFeeOtherInstructions,
      };
      cache.set(key, { at: Date.now(), value });
      return value;
    } catch {
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, request);
  return request;
}

/** Test-only: reset the module cache between cases. */
export function clearApplicationFeePreviewCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
