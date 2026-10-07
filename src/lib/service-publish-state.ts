import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

/** The work-board publish fields on a service row. Written only by `/api/portal/service-publish` and the hire. */
export const SERVER_OWNED_PUBLISH_KEYS = [
  "published",
  "publishedAt",
  "publishRef",
  "publishBudgetCents",
  "publishSharePhotos",
] as const satisfies readonly (keyof DemoManagerWorkOrderRow)[];

/**
 * Replace whatever publish state a client row carries with the persisted copy (or drop it when the
 * stored row has none). Mutates `incoming`, like the dispatch restore beside it in
 * `/api/portal-work-orders`.
 */
export function restoreServerPublishState(
  incoming: DemoManagerWorkOrderRow,
  stored: DemoManagerWorkOrderRow | null,
): void {
  const target = incoming as unknown as Record<string, unknown>;
  const source = (stored ?? {}) as unknown as Record<string, unknown>;
  for (const key of SERVER_OWNED_PUBLISH_KEYS) {
    if (source[key] === undefined) delete target[key];
    else target[key] = source[key];
  }
}
