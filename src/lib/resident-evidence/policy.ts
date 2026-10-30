export type EvidenceRequirement = "none" | "id" | "background" | "both";
export type EvidencePurpose = "application" | "tour" | "short_stay";
export type EvidencePolicy = {
  id: string; property_id: string; manager_user_id: string; version: number;
  application_requirement: EvidenceRequirement; tour_requirement: EvidenceRequirement; short_stay_requirement: EvidenceRequirement;
  jurisdiction_state: string; jurisdiction_city: string; legal_review_reference: string; legal_approved: boolean;
  identity_max_age_days: number | null; screening_products: string[]; tour_background_purpose_approved: boolean;
};
export type EvidenceProperty = { manager_user_id: string | null; property_data: unknown };
export type IdentityAttestation = { status: string; verified_at: string | null } | null;
const US_JURISDICTIONS = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "));
export type EvidenceResolution =
  | { kind: "disabled" }
  | { kind: "unavailable"; reason: string }
  | { kind: "resolved"; policyId: string; version: number; requirement: EvidenceRequirement; propertyId: string; managerUserId: string; jurisdiction: { state: string; city: string; zip: string }; identity: "not_required" | "verified" | "missing" | "expired"; background: "not_required" | "unavailable"; allowed: boolean };

/** Only server-loaded inputs may be used for authorization decisions. */
export function evaluateEvidencePolicy(input: { enabled: boolean; propertyId: string; purpose: EvidencePurpose; property: EvidenceProperty | null; policy: EvidencePolicy | null; identity: IdentityAttestation; personaConfigured: boolean; now?: number }): EvidenceResolution {
  if (!input.enabled) return { kind: "disabled" };
  const { property, policy } = input;
  if (!property?.manager_user_id || !policy || policy.manager_user_id !== property.manager_user_id || policy.property_id !== input.propertyId) return { kind: "unavailable", reason: "policy_unavailable" };
  const data = property.property_data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return { kind: "unavailable", reason: "jurisdiction_unknown" };
  const raw = data as Record<string, unknown>;
  const clean = (v: unknown) => typeof v === "string" ? v.trim() : "";
  const address = clean(raw.address), state = clean(raw.state).toUpperCase(), city = clean(raw.city), zip = clean(raw.zip);
  if (!address || !US_JURISDICTIONS.has(state) || !city || !/^\d{5}(?:-\d{4})?$/.test(zip) || !policy.legal_approved || !policy.legal_review_reference.trim() || state !== policy.jurisdiction_state.trim().toUpperCase() || city.toLowerCase() !== policy.jurisdiction_city.trim().toLowerCase()) return { kind: "unavailable", reason: "jurisdiction_or_legal_review_unknown" };
  const requirement = policy[`${input.purpose}_requirement`];
  if (!["none", "id", "background", "both"].includes(requirement)) return { kind: "unavailable", reason: "policy_invalid" };
  const needsId = requirement === "id" || requirement === "both";
  const needsBackground = requirement === "background" || requirement === "both";
  if (needsBackground && (!Array.isArray(policy.screening_products) || policy.screening_products.length === 0 || policy.screening_products.some((p) => !["credit", "eviction", "criminal"].includes(p)))) return { kind: "unavailable", reason: "screening_products_unknown" };
  if (needsBackground && input.purpose === "tour" && !policy.tour_background_purpose_approved) return { kind: "unavailable", reason: "tour_purpose_unapproved" };
  if (needsId && (!policy.identity_max_age_days || !Number.isInteger(policy.identity_max_age_days) || policy.identity_max_age_days <= 0)) return { kind: "unavailable", reason: "identity_validity_unknown" };
  let identity: "not_required" | "verified" | "missing" | "expired" = "not_required";
  if (needsId) {
    const verifiedAt = input.identity?.status === "approved" && input.identity.verified_at ? Date.parse(input.identity.verified_at) : NaN;
    const now = input.now ?? Date.now();
    identity = Number.isFinite(verifiedAt) && verifiedAt <= now ? (now - verifiedAt < policy.identity_max_age_days! * 86400000 ? "verified" : "expired") : "missing";
    if (identity !== "verified" && !input.personaConfigured) return { kind: "unavailable", reason: "identity_provider_unavailable" };
  }
  const background = needsBackground ? "unavailable" : "not_required";
  return { kind: "resolved", policyId: policy.id, version: policy.version, requirement, propertyId: input.propertyId, managerUserId: property.manager_user_id, jurisdiction: { state, city, zip }, identity, background, allowed: (identity === "not_required" || identity === "verified") && background === "not_required" };
}
