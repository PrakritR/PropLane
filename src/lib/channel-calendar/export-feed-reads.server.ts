import "server-only";
import { createTtlCache, serverSnapshotCacheEnabled } from "@/lib/server-ttl-cache";

/**
 * A channel polls a feed every few hours, and each poll used to repeat the same reads for the house: its sibling
 * connections (every column, import tokens included) and four paged reads of approved applications. This keeps ONE
 * answer per house for 60 seconds, shared between concurrent fetches (a house's rooms are polled together), and
 * never caches a failure. Anything that writes a house's stays calls {@link invalidateFeedReads}.
 */
const FEED_READ_TTL_MS = 60_000;
const cache = createTtlCache<unknown>(FEED_READ_TTL_MS, Date.now, { maxEntries: 200 });

export async function cachedFeedRead<T>(kind: "siblings" | "approved", propertyId: string, load: () => Promise<T>): Promise<T> {
  if (!serverSnapshotCacheEnabled()) return load();
  return (await cache.get(`${kind}:${propertyId}`, load as () => Promise<unknown>)) as T;
}

/** A write to a house's imported ranges or stays: the next fetch re-reads (the key space is small, so clear all). */
export function invalidateFeedReads(): void {
  cache.clear();
}
