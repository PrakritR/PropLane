/**
 * Leaf module for property-pipeline event names.
 *
 * These are plain string constants with NO imports, so they can be pulled into
 * any module without participating in an import cycle. Keeping them here (rather
 * than in `demo-property-pipeline.ts`) breaks the manager-portfolio-access ↔
 * demo-property-pipeline TDZ: `MANAGER_PORTFOLIO_REFRESH_EVENTS` in
 * `manager-portfolio-access.ts` reads `PROPERTY_PIPELINE_EVENT` at module-eval
 * time, and the property-ordering cycle
 * (demo-property-pipeline → persisted-property-records → demo-admin-property-inventory
 * → manager-portfolio-access → demo-property-pipeline) meant the const could be
 * accessed before its initializer ran. A leaf with no imports is always fully
 * evaluated before any importer's body executes.
 */

export const PROPERTY_PIPELINE_EVENT = "axis-property-pipeline";
export const PRO_RELATIONSHIPS_EVENT = "axis-pro-relationships";

/** Dispatched when manager application rows change in the portal store. */
export const MANAGER_APPLICATIONS_EVENT = "axis:manager-applications";

/**
 * Marks the dispatch that a SERVER SYNC makes after it has already written the
 * fresh snapshot into the local store.
 *
 * Several panels listen for these events and respond by forcing another server
 * sync. When the event came from a sync, that is a feedback loop: the listener
 * re-fetches data it was just handed. Measured on `/portal/properties`, it
 * doubled the request count (`/api/property-records` 4x where 2 would do) and
 * was previously damped only by a snapshot-signature equality check.
 *
 * Listeners should call `isServerSyncOriginatedEvent(e)` and, when true, just
 * re-read local state instead of forcing a round trip. Local mutations keep
 * dispatching an untagged event, so a listener that genuinely needs a re-read
 * after a local write still gets one.
 */
export function serverSyncOriginatedEvent(name: string): Event {
  return new CustomEvent(name, { detail: { fromServerSync: true } });
}

export function isServerSyncOriginatedEvent(event: Event): boolean {
  return (event as CustomEvent<{ fromServerSync?: boolean }>).detail?.fromServerSync === true;
}
