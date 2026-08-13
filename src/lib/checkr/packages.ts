import type { CheckrPackage } from "@/lib/checkr/config";

/** Checkr Tenant add-on slugs (see Testing → Identity Verification add-on). */
export type CheckrAddOnSlug = "identity_verification";

export type CheckrPackageCatalogEntry = {
  slug: CheckrPackage;
  name: string;
  priceCents: number;
  tagline: string;
  /** Human-readable inclusions shown in the package picker. */
  features: string[];
  /** When set, UI shows "Everything in {inheritsFrom}". */
  inheritsLabel?: string;
  popular?: boolean;
};

export type CheckrAddOnCatalogEntry = {
  slug: CheckrAddOnSlug;
  name: string;
  priceCents: number;
  description: string;
  badge?: string;
};

/** Default Checkr Tenant retail pricing (override via env if your account differs). */
export const CHECKR_PACKAGE_CATALOG: CheckrPackageCatalogEntry[] = [
  {
    slug: "starter",
    name: "Starter",
    priceCents: 2499,
    tagline: "Essential checks for landlords just getting started.",
    features: ["Criminal history", "Global watchlist", "Sex offender registry"],
  },
  {
    slug: "essential",
    name: "Essential",
    priceCents: 3499,
    tagline: "Financials, rental history, and background in one report.",
    inheritsLabel: "Starter",
    features: ["Credit report", "Credit score", "Eviction history"],
    popular: true,
  },
  {
    slug: "complete",
    name: "Complete",
    priceCents: 4499,
    tagline: "Income, employment, and asset verification included.",
    inheritsLabel: "Essential",
    features: ["Income verification", "Assets & bank report"],
  },
];

export const CHECKR_ADD_ON_CATALOG: CheckrAddOnCatalogEntry[] = [
  {
    slug: "identity_verification",
    name: "Identity protection",
    priceCents: 295,
    description: "Government ID verification to reduce impersonation risk.",
    badge: "New",
  },
];

export function checkrPackageCatalog(): CheckrPackageCatalogEntry[] {
  return CHECKR_PACKAGE_CATALOG.map((entry) => ({
    ...entry,
    priceCents: readPriceOverride(`CHECKR_${entry.slug.toUpperCase()}_PRICE_CENTS`, entry.priceCents),
  }));
}

export function checkrAddOnCatalog(): CheckrAddOnCatalogEntry[] {
  return CHECKR_ADD_ON_CATALOG.map((entry) => ({
    ...entry,
    priceCents: readPriceOverride("CHECKR_IDENTITY_ADDON_PRICE_CENTS", entry.priceCents),
  }));
}

function readPriceOverride(envKey: string, fallback: number): number {
  const raw = Number(process.env[envKey]);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : fallback;
}

export function isCheckrPackage(value: string): value is CheckrPackage {
  return value === "starter" || value === "essential" || value === "complete";
}

export function isCheckrAddOn(value: string): value is CheckrAddOnSlug {
  return value === "identity_verification";
}

export function checkrOrderCostCents(
  packageSlug: CheckrPackage,
  addOnProducts: readonly CheckrAddOnSlug[] = [],
): number {
  return sumScreeningOrderCents(
    packageSlug,
    addOnProducts,
    checkrPackageCatalog(),
    checkrAddOnCatalog(),
  );
}

/** Sum package + selected add-ons from a catalog snapshot (API-loaded or default). */
export function sumScreeningOrderCents(
  packageSlug: CheckrPackage,
  addOnSlugs: readonly CheckrAddOnSlug[],
  packages: readonly Pick<CheckrPackageCatalogEntry, "slug" | "priceCents">[],
  addOns: readonly Pick<CheckrAddOnCatalogEntry, "slug" | "priceCents">[],
): number {
  const base = packages.find((entry) => entry.slug === packageSlug)?.priceCents ?? 0;
  const addOnTotal = addOnSlugs.reduce((sum, slug) => {
    return sum + (addOns.find((entry) => entry.slug === slug)?.priceCents ?? 0);
  }, 0);
  return base + addOnTotal;
}

/** Stripe product title — includes selected add-ons so the charged amount matches the label. */
export function buildScreeningCheckoutProductName(
  packageSlug: CheckrPackage,
  addOnProducts: readonly CheckrAddOnSlug[] = [],
): string {
  const pkg = checkrPackageCatalog().find((p) => p.slug === packageSlug);
  const pkgName = pkg?.name ?? packageSlug;
  const addOnNames = addOnProducts
    .map((slug) => checkrAddOnCatalog().find((a) => a.slug === slug)?.name)
    .filter((name): name is string => Boolean(name));
  if (addOnNames.length === 0) return `Applicant screening — ${pkgName}`;
  return `Applicant screening — ${pkgName} + ${addOnNames.join(" + ")}`;
}

export function screeningCheckoutDescription(
  packageSlug: CheckrPackage,
  addOnProducts: readonly CheckrAddOnSlug[] = [],
): string | undefined {
  const pkg = checkrPackageCatalog().find((p) => p.slug === packageSlug);
  const parts: string[] = [];
  if (pkg?.tagline) parts.push(pkg.tagline);
  for (const slug of addOnProducts) {
    const addOn = checkrAddOnCatalog().find((a) => a.slug === slug);
    if (addOn) parts.push(`Includes ${addOn.name.toLowerCase()}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function formatCheckrPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
