import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverPortalMessageThreadSide } from "@/lib/portal-inbox-delivery";

/**
 * Plan admin-money-1008, D9. A thread keeps the recordRef of whoever first composed from a record (a later reply
 * never relabels it), so a SECOND job with the same vendor reuses the thread under the first job's ref. Each turn
 * is therefore stamped with the record it was composed from, which is how the second job's Communication finds
 * its own turns (`threadAboutService`, `messageAboutService`).
 */
type StoredRow = {
  id: string;
  scope: string;
  owner_user_id: string | null;
  participant_email: string | null;
  thread_type: string;
  row_data: Record<string, unknown>;
  updated_at: string;
};

function makeFakeDb(seed: StoredRow[]) {
  const rows: StoredRow[] = [...seed];
  const select = () => {
    const filters: [string, unknown][] = [];
    const value = (row: StoredRow, col: string): unknown =>
      col === "row_data->>email" ? row.row_data.email : col === "row_data->>folder" ? row.row_data.folder : (row as unknown as Record<string, unknown>)[col];
    const builder = {
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      then<T>(resolve: (v: { data: StoredRow[]; error: null }) => T) {
        return Promise.resolve({ data: rows.filter((row) => filters.every(([c, v]) => value(row, c) === v)), error: null }).then(resolve);
      },
    };
    return builder;
  };
  return {
    from: () => ({
      select,
      upsert: (row: StoredRow) => {
        const idx = rows.findIndex((r) => r.id === row.id);
        if (idx >= 0) rows[idx] = { ...rows[idx], ...row };
        else rows.push({ ...row });
        return Promise.resolve({ error: null });
      },
    }),
    __rows: rows,
  } as unknown as SupabaseClient & { __rows: StoredRow[] };
}

const SCOPE = "axis_portal_inbox_manager_v1";
const JOB_A = { kind: "service" as const, id: "wo-A", label: "Sink" };
const JOB_B = { kind: "service" as const, id: "wo-B", label: "Faucet" };

const vendorThread = (): StoredRow => ({
  id: "thr-vendor",
  scope: SCOPE,
  owner_user_id: "mgr-1",
  participant_email: null,
  thread_type: "portal_message",
  row_data: {
    folder: "sent",
    email: "pacific@example.com",
    from: "You",
    subject: "Sink",
    body: "Sink job quote?",
    recordRef: JOB_A,
    messages: [{ id: "a2", from: "Pacific Plumbing", body: "Sink fixed.", at: "Sep 2, 9:00 AM", outbound: false }],
  },
  updated_at: "2026-09-02T09:00:00.000Z",
});

const send = (db: SupabaseClient, recordRef?: typeof JOB_B) =>
  deliverPortalMessageThreadSide(db, {
    scope: SCOPE,
    folder: "sent",
    ownerUserId: "mgr-1",
    participantEmail: null,
    otherPartyEmail: "pacific@example.com",
    fallbackId: "thr-new",
    fromName: "You",
    subject: "Faucet",
    body: "Faucet job: Thursday?",
    preview: "Faucet job: Thursday?",
    when: "Sep 22, 8:46 AM",
    unread: false,
    outbound: true,
    ...(recordRef ? { recordRef } : {}),
  });

describe("a turn carries the record it was composed from", () => {
  it("an append about a second job stamps the turn with it and leaves the thread's first recordRef alone", async () => {
    const db = makeFakeDb([vendorThread()]);
    const result = await send(db, JOB_B);
    expect(result).toMatchObject({ action: "append", threadId: "thr-vendor" });
    const rowData = (db as unknown as { __rows: StoredRow[] }).__rows[0]!.row_data;
    expect(rowData.recordRef).toEqual(JOB_A);
    const messages = rowData.messages as { id: string; recordRef?: unknown }[];
    expect(messages).toHaveLength(2);
    expect(messages[0]!.recordRef).toBeUndefined();
    expect(messages[1]!.recordRef).toEqual(JOB_B);
  });

  it("a send with no record stamps no turn", async () => {
    const db = makeFakeDb([vendorThread()]);
    await send(db);
    const messages = (db as unknown as { __rows: StoredRow[] }).__rows[0]!.row_data.messages as { recordRef?: unknown }[];
    expect(messages[1]!.recordRef).toBeUndefined();
  });
});
