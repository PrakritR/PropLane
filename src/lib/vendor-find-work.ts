import { publicServiceTradeLabel } from "@/lib/public-service-projection";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

/**
 * Find work filters (vendor-work-share-1006). The board's `trade` filter matches the service's
 * category key, so the Trade dropdown's values are category keys and its labels the public trade
 * names; the Distance dropdown's values are miles (blank = any).
 */
const FIND_WORK_CATEGORIES = [
  "general",
  "plumbing",
  "electrical",
  "hvac",
  "appliance",
  "cleaning",
  "mold",
  "access",
] as const satisfies readonly NonNullable<DemoManagerWorkOrderRow["category"]>[];

export const FIND_WORK_TRADE_OPTIONS: Array<{ value: string; label: string }> = FIND_WORK_CATEGORIES.map((value) => ({
  value,
  label: publicServiceTradeLabel(value),
}));

export const FIND_WORK_DISTANCE_OPTIONS: Array<{ value: string; label: string }> = [5, 10, 25, 50].map((mi) => ({
  value: String(mi),
  label: `${mi} mi`,
}));

/** "" (Any) or a non-numeric value is no radius filter. */
export function findWorkRadiusMi(value: string): number | undefined {
  const mi = Number(value);
  return Number.isFinite(mi) && mi > 0 ? mi : undefined;
}
