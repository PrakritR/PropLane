/**
 * "Copy all PropLane links" and "Paste many" for the channel link popup: 28 rooms are 28 links to copy
 * out and 28 to paste in, and doing them one at a time is how this took an afternoon. Pure; the popup
 * owns the state and the one batch save.
 */
import { channelImportUrlErrorMessage, isValidChannelImportUrl, normalizeChannelImportUrl } from "@/lib/channel-calendar/airbnb-url";
import type { ChannelCalendarProvider } from "@/lib/channel-calendar/types";

/** A paste is a few KB at most; anything past this is not a list of calendar links. */
export const PASTE_MANY_MAX_LINKS = 120;

const TRAILING = /[.,;:)\]>"'’”]+$/;

/**
 * The https links in a pasted block, in order, one per find: a bare link on each line, "Room 3: https://…",
 * a bullet, or several on a line. Duplicates are kept (the review row says which is the repeat).
 */
export function parsePastedLinks(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const link = normalizeChannelImportUrl(match[0].replace(TRAILING, ""));
    if (link) found.push(link);
    if (found.length >= PASTE_MANY_MAX_LINKS) break;
  }
  return found;
}

export type BulkRoom = { key: string; label: string; /** The room already has a saved or typed link. */ filled: boolean };

/**
 * Matches pasted links to rooms in the order the popup lists them, taking rooms that have no link yet first
 * (a half-linked workspace is the common case) and the remaining rooms after, so a full re-paste lines up too.
 * A link with no room left stays unassigned (`""`).
 */
export function matchLinksToRooms(links: readonly string[], rooms: readonly BulkRoom[]): string[] {
  const order = [...rooms.filter((room) => !room.filled), ...rooms.filter((room) => room.filled)];
  return links.map((_link, index) => order[index]?.key ?? "");
}

export type BulkRow = { id: string; url: string; roomKey: string };

export type BulkRowCheck = { ok: true } | { ok: false; error: string };

/**
 * Per-link validation with the channel's own validator (the same one a single paste goes through, so the
 * fetcher can never be aimed at an arbitrary host), plus the two mistakes a list invites: one link given to
 * two rooms, or two links given to one room. A row with no room is skipped, not wrong.
 */
export function checkBulkRows(
  provider: ChannelCalendarProvider,
  rows: readonly BulkRow[],
  roomLabel: (key: string) => string,
): Map<string, BulkRowCheck> {
  const out = new Map<string, BulkRowCheck>();
  const firstByUrl = new Map<string, BulkRow>();
  const firstByRoom = new Map<string, BulkRow>();
  for (const row of rows) {
    if (!row.roomKey) {
      out.set(row.id, { ok: true });
      continue;
    }
    if (!isValidChannelImportUrl(provider, row.url)) {
      out.set(row.id, { ok: false, error: channelImportUrlErrorMessage(provider) });
      continue;
    }
    const sameUrl = firstByUrl.get(row.url);
    if (sameUrl) {
      out.set(row.id, { ok: false, error: `Same link as ${roomLabel(sameUrl.roomKey)}.` });
      continue;
    }
    const sameRoom = firstByRoom.get(row.roomKey);
    if (sameRoom) {
      out.set(row.id, { ok: false, error: `${roomLabel(row.roomKey)} already has a link in this list.` });
      continue;
    }
    firstByUrl.set(row.url, row);
    firstByRoom.set(row.roomKey, row);
    out.set(row.id, { ok: true });
  }
  return out;
}

/** The drafts a reviewed paste becomes: room key -> link, for the rows that are assigned and valid. */
export function draftsFromBulkRows(rows: readonly BulkRow[], checks: ReadonlyMap<string, BulkRowCheck>): Record<string, string> {
  const drafts: Record<string, string> = {};
  for (const row of rows) {
    if (row.roomKey && checks.get(row.id)?.ok) drafts[row.roomKey] = row.url;
  }
  return drafts;
}

/** "4709A 8th Ave · Room 3: https://…", one per line: what Copy all puts on the clipboard. */
export function copyAllLinksText(entries: ReadonlyArray<{ house: string; room: string; url: string }>): string {
  return entries
    .filter((entry) => entry.url.trim())
    .map((entry) => `${entry.house} · ${entry.room}: ${entry.url.trim()}`)
    .join("\n");
}

/** Runs `task` over `items` with at most `limit` in flight; results keep the items' order. Never rejects: each result says how it went. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results = new Array<{ ok: true; value: R } | { ok: false; error: unknown }>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await task(items[index]!, index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}
