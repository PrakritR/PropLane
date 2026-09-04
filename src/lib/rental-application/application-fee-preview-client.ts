/**
 * Client fetcher for the SERVER-authoritative application-fee itemization
 * (`POST /api/public/application-fee-preview` → `resolveApplicationFeeProperty`
 * → `effectiveApplicationFeeCents`, which consults the manager-level fee).
 *
 * This is the money-path source of truth the apply wizard must derive its
 * gate (needsFee), displayed amount, AND booked charge from — the per-listing
 * `applicationFee` the browser catalog carries is only the grandfathered
 * fallback and can disagree with what checkout actually charges. Cached with a
 * TTL + in-flight guard (the shared client-sync pattern) so the wizard's
 * several consumers share one request.
 *
 * The cache key carries the VIEWER's id as well as the listing, because
 * `repeatApplicantFeeWaived` is resolved from the caller's session — a
 * signed-out answer served back to the same device after sign-in would charge a
 * genuine repeat applicant the fee they are owed a waiver on.
 */

import type { ApplicationFeeChargePolicy } from "@/lib/manager-application-settings";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { safeBrowserGetSession } from "@/lib/supabase/safe-browser-session";

export type ApplicationFeePreview = {
  applicationFeeCents: number;
  serviceFeeCents: number;
  totalCents: number;
  chargePolicy?: ApplicationFeeChargePolicy;
  repeatApplicantFeeWaived?: boolean;
  applicationFeeOtherEnabled?: boolean;
  applicationFeeOtherInstructions?: string;
};

export type ApplicationFeePreviewFetchResult = {
  preview: ApplicationFeePreview | null;
  /** Resolved from the property record when the browser catalog missed the manager id. */
  managerUserId?: string;
  propertyNotFound?: boolean;
};

const PREVIEW_TTL_MS = 60_000;

const cache = new Map<string, { at: number; value: ApplicationFeePreviewFetchResult }>();
const inFlight = new Map<string, Promise<ApplicationFeePreviewFetchResult>>();

function keyFor(propertyId: string, managerUserId: string): string {
  return `${propertyId.trim()}::${managerUserId.trim() || "server"}`;
}

/** Local-only session read — this identifies a cache bucket, never authorizes. */
async function viewerCacheId(): Promise<string> {
  if (typeof window === "undefined") return "anon";
  try {
    const { session } = await safeBrowserGetSession(createSupabaseBrowserClient());
    return session?.user?.id ?? "anon";
  } catch {
    return "anon";
  }
}

/**
 * Resolves the server's effective application fee for one listing.
 * Callers must treat `preview: null` as "unknown — do not claim no fee is required",
 * never as free, unless `propertyNotFound` is true.
 */
export async function fetchApplicationFeePreview(input: {
  propertyId: string;
  /** Optional — when omitted the server resolves the owner from the property id. */
  managerUserId?: string;
  rentalType?: "standard" | "short_term";
  /**
   * Only the signed-in caller's own address earns a repeat-applicant waiver —
   * the route ignores it for anyone else and resolves the resident id from the
   * session, never from the browser.
   */
  residentEmail?: string;
}): Promise<ApplicationFeePreviewFetchResult> {
  const propertyId = input.propertyId.trim();
  const managerUserId = input.managerUserId?.trim() ?? "";
  if (!propertyId) return { preview: null };

  const rentalType = input.rentalType === "short_term" ? "short_term" : "standard";
  const residentEmail = input.residentEmail?.trim() ?? "";
  const residentKey = residentEmail.includes("@") ? `::${residentEmail.toLowerCase()}` : "";
  const viewerId = await viewerCacheId();
  const key = `${keyFor(propertyId, managerUserId)}::${rentalType}::${viewerId}${residentKey}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < PREVIEW_TTL_MS) return hit.value;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = (async (): Promise<ApplicationFeePreviewFetchResult> => {
    try {
      const res = await fetch("/api/public/application-fee-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyId,
          ...(managerUserId ? { managerUserId } : {}),
          rentalType: rentalType === "short_term" ? "short_term" : undefined,
          residentEmail: residentEmail.includes("@") ? residentEmail : undefined,
        }),
      });
      if (res.status === 404) {
        const value: ApplicationFeePreviewFetchResult = { preview: null, propertyNotFound: true };
        cache.set(key, { at: Date.now(), value });
        return value;
      }
      const data = (await res.json().catch(() => ({}))) as {
        managerUserId?: string;
        applicationFeeCents?: number;
        serviceFeeCents?: number;
        totalCents?: number;
        chargePolicy?: ApplicationFeeChargePolicy;
        repeatApplicantFeeWaived?: boolean;
        applicationFeeOtherEnabled?: boolean;
        applicationFeeOtherInstructions?: string;
      };
      if (!res.ok || typeof data.applicationFeeCents !== "number") {
        return { preview: null };
      }
      const preview: ApplicationFeePreview = {
        applicationFeeCents: data.applicationFeeCents,
        serviceFeeCents: typeof data.serviceFeeCents === "number" ? data.serviceFeeCents : 0,
        totalCents: typeof data.totalCents === "number" ? data.totalCents : data.applicationFeeCents,
        chargePolicy: data.chargePolicy,
        repeatApplicantFeeWaived: data.repeatApplicantFeeWaived,
        applicationFeeOtherEnabled: data.applicationFeeOtherEnabled,
        applicationFeeOtherInstructions: data.applicationFeeOtherInstructions,
      };
      const value: ApplicationFeePreviewFetchResult = {
        preview,
        managerUserId: typeof data.managerUserId === "string" ? data.managerUserId.trim() : managerUserId || undefined,
      };
      cache.set(key, { at: Date.now(), value });
      return value;
    } catch {
      return { preview: null };
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
