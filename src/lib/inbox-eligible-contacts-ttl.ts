/**
 * How long a settled `/api/portal/inbox-eligible-contacts` answer is reused
 * (through `sharedGet`). Short on purpose: the list changes when someone adds a
 * resident or vendor, and the composer merges the local lists on top anyway.
 */
export const ELIGIBLE_CONTACTS_TTL_MS = 10_000;
