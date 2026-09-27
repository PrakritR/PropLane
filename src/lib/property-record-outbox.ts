/**
 * Outbox for the local-first property-record writes (`mirrorPropertyRecord`).
 *
 * Those saves update this browser's copy first and send the server write in the
 * background. Each write is recorded here until the server answers, so one that
 * never lands (offline, tab closed mid-request, a 5xx) is retried by the next
 * pipeline sync instead of silently vanishing when that sync replaces the local
 * copy with the server's. It replaces the old page-load mirror, which re-uploaded
 * every property on every visit: an empty outbox sends nothing.
 *
 * One entry per record id, latest write wins. Entries are scoped to the viewer
 * who made them, so a different account in the same browser never replays them;
 * the pipeline clears the outbox when the viewer signs out. A delete, unlist or
 * other status change for a record discards its unsent write, so a replay can
 * never resurrect what the manager just took down.
 */

import type { PropertyPipelineSnapshot } from "@/lib/persisted-property-records";
import type { ManagerPendingPropertyRow } from "@/lib/demo-property-pipeline";
import type { MockProperty } from "@/data/types";

export const PROPERTY_RECORD_OUTBOX_KEY = "axis_property_record_outbox_v1";
/**
 * ponytail: a replay overwrites whatever the server holds (the route has no
 * client base version to compare), so an edit unsent this long is dropped
 * rather than risk landing over newer work from another device. Covers a
 * reload or a short outage; a base `updated_at` on the write would lift it.
 */
export const PROPERTY_RECORD_OUTBOX_MAX_AGE_MS = 60 * 60 * 1000;

export type PropertyRecordUpsertBody = {
  action: "upsert";
  id: string;
  managerUserId: string | null;
  status: string;
  rowData?: unknown;
  propertyData?: unknown;
  editRequestNote: string | null;
};

export type PropertyRecordOutboxEntry = {
  viewerId: string;
  seq: number;
  queuedAt: number;
  body: PropertyRecordUpsertBody;
};

type OutboxMap = Record<string, PropertyRecordOutboxEntry>;

/** Fired when the server refuses a queued write; `code` is the route's machine tag. */
export const PROPERTY_RECORD_REFUSED_EVENT = "axis-property-record-refused";
export type PropertyRecordRefusedDetail = { id: string; status: number; message: string; code?: string };

const inFlight = new Set<string>();

/**
 * Never reused, even after an entry is discarded: an older request still in
 * flight settles only its own seq, so it can never clear a newer write.
 */
let lastSeq = 0;
function nextSeq(previous = 0): number {
  lastSeq = Math.max(lastSeq + 1, previous + 1, Date.now());
  return lastSeq;
}
const flightKey = (entry: PropertyRecordOutboxEntry) => `${entry.body.id}:${entry.seq}`;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readOutbox(): OutboxMap {
  try {
    const raw = storage()?.getItem(PROPERTY_RECORD_OUTBOX_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as OutboxMap) : {};
  } catch {
    return {};
  }
}

function writeOutbox(map: OutboxMap) {
  try {
    const store = storage();
    if (!store) return;
    if (Object.keys(map).length === 0) store.removeItem(PROPERTY_RECORD_OUTBOX_KEY);
    else store.setItem(PROPERTY_RECORD_OUTBOX_KEY, JSON.stringify(map));
  } catch {
    // Storage full or blocked: the write is still sent once, as before.
  }
}

/** Remove an entry only if it is still the one that was sent (a newer edit may have replaced it). */
function settle(entry: PropertyRecordOutboxEntry) {
  const map = readOutbox();
  if (map[entry.body.id]?.seq === entry.seq) {
    delete map[entry.body.id];
    writeOutbox(map);
  }
}

/**
 * Send one entry. Success or a 4xx settles it: a 4xx is the server refusing
 * (a 409 means someone else's newer write won), and repeating it cannot help.
 * A network failure or 5xx keeps it for the next sync.
 */
async function send(entry: PropertyRecordOutboxEntry, fetchImpl: typeof fetch): Promise<void> {
  const key = flightKey(entry);
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const res = await fetchImpl("/api/property-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(entry.body),
    });
    if (res.ok) settle(entry);
    else if (res.status >= 400 && res.status < 500) {
      settle(entry);
      // Background work the manager never initiated: say only what the server
      // chose to explain (4xx), never a 5xx's raw database text.
      const body = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
      const detail: PropertyRecordRefusedDetail = {
        id: entry.body.id,
        status: res.status,
        message: typeof body?.error === "string" ? body.error.trim() : "",
        code: typeof body?.code === "string" ? body.code : undefined,
      };
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PROPERTY_RECORD_REFUSED_EVENT, { detail }));
    }
  } catch {
    // Offline or aborted: keep it queued.
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Record a write, then send it. Returns once the server has answered (callers
 * may ignore it). With no known viewer the write is sent once and not kept:
 * an entry must never be replayable under some later session.
 */
export function enqueuePropertyRecordWrite(
  viewerId: string,
  body: PropertyRecordUpsertBody,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const map = readOutbox();
  if (!viewerId) return send({ viewerId, seq: nextSeq(map[body.id]?.seq), queuedAt: Date.now(), body }, fetchImpl);
  const entry: PropertyRecordOutboxEntry = {
    viewerId,
    seq: nextSeq(map[body.id]?.seq),
    queuedAt: Date.now(),
    body,
  };
  map[body.id] = entry;
  writeOutbox(map);
  return send(entry, fetchImpl);
}

/** Forget any unsent write for this record (it was deleted, unlisted, or changed status). */
export function discardPropertyRecordWrite(id: string) {
  const map = readOutbox();
  if (!(id in map)) return;
  delete map[id];
  writeOutbox(map);
}

/** Drop every unsent write (sign-out): full property payloads must not outlive the session. */
export function clearPropertyRecordOutbox() {
  writeOutbox({});
}

/** This viewer's unsent writes, dropping (and forgetting) any older than the max age. */
export function pendingPropertyRecordWrites(viewerId: string, now = Date.now()): PropertyRecordOutboxEntry[] {
  const map = readOutbox();
  let expired = false;
  for (const [id, entry] of Object.entries(map)) {
    if (now - entry.queuedAt > PROPERTY_RECORD_OUTBOX_MAX_AGE_MS) {
      delete map[id];
      expired = true;
    }
  }
  if (expired) writeOutbox(map);
  return Object.values(map).filter((entry) => entry.viewerId === viewerId);
}

/** Retry this viewer's unsent writes, in order, before a sync reads the server. */
export async function flushPropertyRecordOutbox(viewerId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!viewerId) return;
  const entries = pendingPropertyRecordWrites(viewerId).sort((a, b) => a.queuedAt - b.queuedAt);
  // Sequential, like every other multi-row property write: each may claim a
  // plan listing slot the server counts before accepting the next.
  for (const entry of entries) await send(entry, fetchImpl);
}

/**
 * Lay still-unsent writes over a fresh server snapshot, so a sync that runs
 * while a write is in flight (or after one failed) never shows the manager
 * their edit reverting. Only `pending` (row) and `live`/`review` (listing)
 * records are local-first; any other status is left to the server.
 */
export function overlayPendingPropertyWrites(
  snapshot: PropertyPipelineSnapshot,
  entries: PropertyRecordOutboxEntry[],
): PropertyPipelineSnapshot {
  if (entries.length === 0) return snapshot;
  const pendingByUser = { ...snapshot.pendingByUser };
  const extrasByUser = { ...snapshot.extrasByUser };
  // Replace the row in whichever bucket already holds it: a co-manager's edit
  // carries the editor's id, but the listing lives in the owner's bucket.
  const upsert = <T extends { id: string }>(buckets: Record<string, T[]>, fallbackOwner: string, row: T) => {
    const holder = Object.keys(buckets).find((uid) => buckets[uid]?.some((r) => r.id === row.id));
    const key = holder ?? fallbackOwner;
    const rows = [...(buckets[key] ?? [])];
    const idx = rows.findIndex((r) => r.id === row.id);
    if (idx === -1) rows.push(row);
    else rows[idx] = row;
    buckets[key] = rows;
  };
  for (const { body } of entries) {
    const owner = body.managerUserId?.trim();
    if (!owner) continue;
    if (body.status === "pending" && body.rowData && typeof body.rowData === "object") {
      upsert(pendingByUser, owner, body.rowData as ManagerPendingPropertyRow);
    } else if ((body.status === "live" || body.status === "review") && body.propertyData && typeof body.propertyData === "object") {
      upsert(extrasByUser, owner, body.propertyData as MockProperty);
    }
  }
  return { ...snapshot, pendingByUser, extrasByUser };
}
