import "server-only";

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe";
import { resolveConnectDestinationIfReady } from "@/lib/stripe-connect";
import { describeOwnerFee, type OwnerAgreementTerms } from "@/lib/owner-management/fee-math";
import { AgreementError, type AgreementRow } from "@/lib/owner-management/agreements.server";

/** Whether an owner can be paid right now: true / false, or null when Stripe could not be asked. */
export async function ownerPayoutReady(db: SupabaseClient, ownerUserId: string): Promise<boolean | null> {
  try {
    return Boolean(await resolveConnectDestinationIfReady(getStripe(), db, ownerUserId));
  } catch {
    return null;
  }
}

export type AgreementView = {
  id: string;
  propertyId: string;
  ownerUserId: string;
  ownerName: string;
  status: AgreementRow["status"];
  feeLine: string;
  terms: OwnerAgreementTerms;
  startsOn: string;
  endsOn: string | null;
  sentAt: string | null;
  signedAt: string | null;
  payoutReady: boolean | null;
};

export function presentAgreement(row: AgreementRow, ownerName: string, payoutReady: boolean | null): AgreementView {
  return {
    id: row.id,
    propertyId: row.propertyId,
    ownerUserId: row.ownerUserId,
    ownerName,
    status: row.status,
    feeLine: describeOwnerFee(row.terms),
    terms: row.terms,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    sentAt: row.sentAt,
    signedAt: row.signedAt,
    payoutReady,
  };
}

export function agreementErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof AgreementError) {
    return NextResponse.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status });
  }
  console.error("[owner-management]", error instanceof Error ? error.name : "unknown");
  return NextResponse.json({ error: fallback }, { status: 500 });
}

function cents(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

/** Parse the terms from a request body. Anything malformed is a 400; no field defaults silently to a fee. */
export function parseTermsBody(body: Record<string, unknown>, base?: OwnerAgreementTerms): OwnerAgreementTerms | null {
  const model = body.feeModel === "flat_monthly" ? "flat_monthly" : body.feeModel === "percent_of_collected" ? "percent_of_collected" : base?.feeModel;
  if (!model) return null;
  const pick = (key: keyof OwnerAgreementTerms, fallback: number): number | null => {
    if (!(key in body)) return fallback;
    return cents(body[key]);
  };
  const feeBps = pick("feeBps", base?.feeBps ?? 0);
  const feeFlatCents = pick("feeFlatCents", base?.feeFlatCents ?? 0);
  const leasingFeeBps = pick("leasingFeeBps", base?.leasingFeeBps ?? 0);
  const minFeeCents = pick("minFeeCents", base?.minFeeCents ?? 0);
  const repairApprovalThresholdCents = pick("repairApprovalThresholdCents", base?.repairApprovalThresholdCents ?? 25_000);
  const reserveTargetCents = pick("reserveTargetCents", base?.reserveTargetCents ?? 0);
  if ([feeBps, feeFlatCents, leasingFeeBps, minFeeCents, repairApprovalThresholdCents, reserveTargetCents].some((v) => v === null)) return null;
  return {
    feeModel: model,
    feeBps: feeBps!,
    feeFlatCents: feeFlatCents!,
    leasingFeeBps: leasingFeeBps!,
    minFeeCents: minFeeCents!,
    repairApprovalThresholdCents: repairApprovalThresholdCents!,
    reserveTargetCents: reserveTargetCents!,
  };
}
