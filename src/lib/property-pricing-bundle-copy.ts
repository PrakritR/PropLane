import {
  normalizeManagerListingSubmissionV1,
  type ManagerBundleRow,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

export function pricingCopySourceBundles(
  sub: ManagerListingSubmissionV1,
  bundleId: string,
  term: string,
): ManagerBundleRow[] {
  const n = normalizeManagerListingSubmissionV1(sub);
  return (n.bundles ?? []).filter((b) => {
    if (b.id === bundleId) return false;
    const copyFrom = b.copyFromBundleIdByTerm?.[term];
    if (copyFrom) return false;
    const price = Number(String(b.price ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(price) && price > 0;
  });
}

export function setBundlePricingCopyFrom(
  sub: ManagerListingSubmissionV1,
  bundleId: string,
  term: string,
  sourceBundleId: string | null,
): ManagerListingSubmissionV1 {
  const n = normalizeManagerListingSubmissionV1(sub);
  const bundles = (n.bundles ?? []).map((b) => {
    if (b.id !== bundleId) return b;
    const copyFromBundleIdByTerm = { ...(b.copyFromBundleIdByTerm ?? {}) };
    if (sourceBundleId) copyFromBundleIdByTerm[term] = sourceBundleId;
    else delete copyFromBundleIdByTerm[term];
    if (sourceBundleId) {
      const src = (n.bundles ?? []).find((x) => x.id === sourceBundleId);
      if (src) {
        return {
          ...b,
          copyFromBundleIdByTerm,
          price: src.price,
          securityDeposit: src.securityDeposit,
          termPricing: src.termPricing ? { ...src.termPricing } : b.termPricing,
        };
      }
    }
    return { ...b, copyFromBundleIdByTerm };
  });
  return { ...n, bundles };
}
