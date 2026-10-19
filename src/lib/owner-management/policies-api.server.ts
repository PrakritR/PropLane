import "server-only";

import { NextResponse } from "next/server";
import { describeManagedFee, type ManagedFeeTerms } from "@/lib/owner-management/fee-math";
import { PolicyError, type PolicyRow } from "@/lib/owner-management/policies.server";

export type PolicyView = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  ownerName: string;
  status: PolicyRow["status"];
  feeLine: string;
  terms: ManagedFeeTerms;
  effectiveFrom: string;
  endsOn: string | null;
  sentAt: string | null;
  signedAt: string | null;
  acceptedVia: PolicyRow["acceptedVia"];
};

export function presentPolicy(row: PolicyRow, ownerName = ""): PolicyView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ownerUserId: row.ownerUserId,
    ownerName,
    status: row.status,
    feeLine: describeManagedFee(row.terms),
    terms: row.terms,
    effectiveFrom: row.effectiveFrom,
    endsOn: row.endsOn,
    sentAt: row.sentAt,
    signedAt: row.signedAt,
    acceptedVia: row.acceptedVia,
  };
}

export function policyErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof PolicyError) {
    return NextResponse.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status });
  }
  console.error("[owner-management]", error instanceof Error ? error.name : "unknown");
  return NextResponse.json({ error: fallback }, { status: 500 });
}

function whole(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

/** Terms from a request body. Missing fields fall back to `base` (an edit) or the documented defaults (a create). */
export function parseTermsBody(body: Record<string, unknown>, base?: ManagedFeeTerms): ManagedFeeTerms | null {
  const pick = (key: keyof ManagedFeeTerms, fallback: number): number | null => (key in body ? whole(body[key]) : fallback);
  const ownerShareBps = pick("ownerShareBps", base?.ownerShareBps ?? 9000);
  const leasingFeeBps = pick("leasingFeeBps", base?.leasingFeeBps ?? 0);
  const minFeeCents = pick("minFeeCents", base?.minFeeCents ?? 0);
  const reserveTargetCents = pick("reserveTargetCents", base?.reserveTargetCents ?? 0);
  const repairApprovalThresholdCents = pick("repairApprovalThresholdCents", base?.repairApprovalThresholdCents ?? 25_000);
  if ([ownerShareBps, leasingFeeBps, minFeeCents, reserveTargetCents, repairApprovalThresholdCents].some((v) => v === null)) return null;
  const appliesTo = body.appliesTo === "all" ? "all" : body.appliesTo === "rent" ? "rent" : (base?.appliesTo ?? "rent");
  return {
    ownerShareBps: ownerShareBps!, appliesTo, leasingFeeBps: leasingFeeBps!, minFeeCents: minFeeCents!,
    reserveTargetCents: reserveTargetCents!, repairApprovalThresholdCents: repairApprovalThresholdCents!,
  };
}
