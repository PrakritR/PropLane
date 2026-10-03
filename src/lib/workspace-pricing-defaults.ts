/**
 * Workspace default rent figures for property Pricing (studio redesign 0929).
 * Stored in `portal_workspaces.payment_settings.pricingDefaults` — additive JSON,
 * no migration. A default is only what the manager set; nothing is invented.
 */

export type WorkspacePricingDefaults = {
  /** Private room monthly rent (USD dollars). */
  rentPrivate?: number;
  /** Shared by 2 — rent per resident (USD). */
  rentShared2?: number;
  /** Shared by 3 or more — rent per resident (USD). */
  rentShared3?: number;
  /** Whole house monthly rent (USD). */
  rentWhole?: number;
  /** Short-term nightly rate (USD). */
  nightly?: number;
};

export const SEATTLE_DEMO_WORKSPACE_PRICING_DEFAULTS: WorkspacePricingDefaults = {
  rentPrivate: 950,
  rentShared2: 700,
  rentShared3: 600,
  rentWhole: 4500,
};

export function normalizeWorkspacePricingDefaults(raw: unknown): WorkspacePricingDefaults {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const num = (k: string) => {
    const n = Number(r[k]);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
  };
  return {
    rentPrivate: num("rentPrivate"),
    rentShared2: num("rentShared2"),
    rentShared3: num("rentShared3"),
    rentWhole: num("rentWhole"),
    nightly: num("nightly"),
  };
}

export function workspaceDefaultRentForRoom(
  defaults: WorkspacePricingDefaults,
  capacity: number,
): number | undefined {
  const cap = Math.max(1, Math.floor(capacity) || 1);
  if (cap === 1) return defaults.rentPrivate;
  if (cap === 2) return defaults.rentShared2;
  return defaults.rentShared3;
}

export function countWorkspacePricingDefaultsSet(defaults: WorkspacePricingDefaults): number {
  return (["rentPrivate", "rentShared2", "rentShared3", "rentWhole", "nightly"] as const).filter(
    (k) => (defaults[k] ?? 0) > 0,
  ).length;
}
