export type ApplicationReceiptStatus =
  | "paid" | "processing" | "partially_refunded" | "refunded" | "not_received" | "needs_review";

export type ApplicationReceipt = {
  status: ApplicationReceiptStatus;
  principalCents?: number;
  refundedCents?: number;
  paidAt?: string;
};

type Claim = {
  application_id: string; manager_user_id: string; property_id: string; resident_email: string;
  charge_id: string; status: string; promotion_status?: string | null;
  stripe_session_id: string | null; principal_cents: number; payer_total_cents: number;
};
type Charge = { id: string; status: string; row_data: Record<string, unknown> };
type Ledger = { manager_user_id: string | null; amount_cents: number; stripe_checkout_session_id?: string | null };

function centsFromLabel(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^\$?\s*(\d[\d,]*)(?:\.(\d{2}))?$/.exec(value.trim());
  if (!match) return undefined;
  const cents = Number(match[1]!.replaceAll(",", "")) * 100 + Number(match[2] ?? "0");
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : undefined;
}

/** Resolve one application's receipt from exact stored sources, never the live listing quote. */
export function applicationPaymentReceipt(input: {
  applicationId: string; managerUserId: string; propertyId: string; residentEmail: string;
  claim: Claim | null; exactCharges: Charge[]; ambiguousLegacyCharges: Charge[];
  payments: Ledger[]; refunds: Ledger[]; overflow?: boolean;
}): ApplicationReceipt {
  const { claim, exactCharges, ambiguousLegacyCharges, payments, refunds } = input;
  const charge = exactCharges[0];
  const amount = claim?.principal_cents ?? centsFromLabel(charge?.row_data.amountLabel) ??
    centsFromLabel(ambiguousLegacyCharges[0]?.row_data.amountLabel);
  const review = (): ApplicationReceipt => ({ status: "needs_review", ...(amount !== undefined ? { principalCents: amount } : {}) });
  if (input.overflow || exactCharges.length > 1 || ambiguousLegacyCharges.length > 0) return review();
  if (claim && (claim.application_id !== input.applicationId || claim.manager_user_id !== input.managerUserId ||
      claim.property_id !== input.propertyId || claim.resident_email.toLowerCase() !== input.residentEmail.toLowerCase() ||
      claim.promotion_status === "needs_review")) return review();
  if (!charge) return claim?.status === "settled" ? review() : claim?.status === "pending"
    ? { status: "processing", ...(amount !== undefined ? { principalCents: amount } : {}) }
    : { status: "not_received" };
  if (claim && charge.id !== claim.charge_id) return review();
  if (["pending", "failed", "cancelled"].includes(charge.status)) return claim?.status === "settled" ? review() : { status: "not_received" };
  if (["processing", "partially_paid"].includes(charge.status)) return { status: "processing", ...(amount !== undefined ? { principalCents: amount } : {}) };
  if (!["paid", "refunded"].includes(charge.status)) return review();

  const sourceSession = charge.row_data.stripeCheckoutSessionId;
  const method = charge.row_data.paidMethod;
  const online = claim?.status === "settled" && typeof sourceSession === "string" &&
    sourceSession === claim.stripe_session_id;
  const offline = !claim && !sourceSession && typeof method === "string" &&
    ["Cash", "Check", "Bank transfer", "Other"].includes(method);
  const paidAt = charge.row_data.paidAt;
  if ((!online && !offline) || typeof paidAt !== "string" || Number.isNaN(Date.parse(paidAt)) ||
      !Number.isSafeInteger(amount) || amount! <= 0 || payments.length !== 1 ||
      payments[0]!.manager_user_id !== input.managerUserId || payments[0]!.amount_cents !== amount ||
      (online && payments[0]!.stripe_checkout_session_id !== claim!.stripe_session_id)) return review();

  const fullPayerAmount = claim?.payer_total_cents ?? amount!;
  if (!Number.isSafeInteger(fullPayerAmount) || fullPayerAmount < amount! ||
      refunds.some((row) => row.manager_user_id !== input.managerUserId ||
        !Number.isSafeInteger(row.amount_cents) || row.amount_cents <= 0)) return review();
  const refundedCents = refunds.reduce((total, row) => total + row.amount_cents, 0);
  if (!Number.isSafeInteger(refundedCents) || refundedCents > fullPayerAmount) return review();
  if (charge.status === "refunded" && refundedCents < fullPayerAmount) return review();
  if (refundedCents >= fullPayerAmount) return { status: "refunded", principalCents: amount!, refundedCents, paidAt };
  if (refundedCents > 0) return { status: "partially_refunded", principalCents: amount!, refundedCents, paidAt };
  return { status: "paid", principalCents: amount!, paidAt };
}
