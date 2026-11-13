/** Minimal decisions only; raw identity evidence stays with the provider. */
export const RESIDENT_IDENTITY_STATUSES = [
  "not_started", "pending", "review", "approved", "declined", "expired",
] as const;
export type ResidentIdentityStatus = (typeof RESIDENT_IDENTITY_STATUSES)[number];

export const RESIDENT_IDENTITY_INQUIRY_STATUSES = [
  "claimed", "pending", "review", "approved", "declined", "expired", "reconciliation",
] as const;
export type ResidentIdentityInquiryStatus = (typeof RESIDENT_IDENTITY_INQUIRY_STATUSES)[number];

export type ResidentIdentityProviderDecision = "approved" | "declined" | "review";
export type ResidentIdentityReviewStatus = "requested" | "in_review" | "approved" | "declined" | "closed";
export type ResidentIdentityEventDisposition = "applied" | "stale" | "ignored";

/** Unknown provider values never imply approval. */
export function parseResidentIdentityStatus(value: unknown): ResidentIdentityStatus | null {
  return typeof value === "string" && (RESIDENT_IDENTITY_STATUSES as readonly string[]).includes(value)
    ? value as ResidentIdentityStatus
    : null;
}
