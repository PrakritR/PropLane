/**
 * `readPartyLines` is the one read of a party's history: the statement folds it, the 1099 totals come out of it
 * and the weekly vendor batch decides who gets paid from it. It used to take a bare `.limit(5000)` and apply its
 * posted-at window in MEMORY afterwards, so past 5000 lines a workspace silently got an arbitrary slice — wrong
 * balances, understated vendor totals, and a vendor outside the slice never paid. The window belongs in SQL and
 * the read must page.
 */
import { describe, expect, it } from "vitest";
import { readPartyLines } from "@/lib/managed-finance/ledger.server";

type Row = Record<string, unknown>;

function line(index: number, postedAt: string): Row {
  return {
    id: `l-${String(index).padStart(5, "0")}`,
    journal_id: `j-${index}`,
    account: "owner_payable",
    party_id: "owner:own-1",
    workspace_id: "ws-1",
    amount_cents: -100,
    available_on: null,
    created_at: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    party_ledger_journals: { kind: "rent_capture", posted_at: postedAt, detail: {}, source_type: null, source_id: null },
  };
}

/** A PostgREST stand-in that honours embedded-column filters, order and range — the three this read now needs. */
function db(rows: Row[]) {
  const calls: { ranges: Array<[number, number]> } = { ranges: [] };
  const client = {
    from() {
      const filters: ((r: Row) => boolean)[] = [];
      const orders: string[] = [];
      const journal = (r: Row) => r.party_ledger_journals as Row;
      const query: Record<string, unknown> = {
        select: () => query,
        eq: (column: string, value: unknown) => (filters.push((r) => r[column] === value), query),
        gte: (column: string, value: unknown) => {
          filters.push((r) => String(journal(r)[column.split(".").pop()!]) >= String(value));
          return query;
        },
        lt: (column: string, value: unknown) => {
          filters.push((r) => String(journal(r)[column.split(".").pop()!]) < String(value));
          return query;
        },
        order: (column: string) => (orders.push(column), query),
        range: (from: number, to: number) => {
          calls.ranges.push([from, to]);
          const matched = rows
            .filter((r) => filters.every((f) => f(r)))
            .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
          return Promise.resolve({ data: matched.slice(from, to + 1), error: null });
        },
      };
      return query;
    },
  };
  return { client: client as never, calls, orders: () => calls.ranges.length };
}

describe("readPartyLines", () => {
  it("reads past the old 5000-row cap by paging", async () => {
    const rows = Array.from({ length: 5_600 }, (_, index) => line(index, "2026-06-01T00:00:00.000Z"));
    const { client, calls } = db(rows);
    const out = await readPartyLines(client, { account: "owner_payable", partyId: "owner:own-1", workspaceId: "ws-1" });
    expect(out).toHaveLength(5_600);
    expect(calls.ranges.length).toBeGreaterThan(1);
  });

  it("applies the window in SQL so truncation can never precede it", async () => {
    // One in-window line sits behind 5,200 out-of-window ones. An in-memory filter after a capped read
    // would have dropped it; a windowed read returns only it.
    const rows = [
      ...Array.from({ length: 5_200 }, (_, index) => line(index, "2025-06-01T00:00:00.000Z")),
      line(9_999, "2026-06-01T00:00:00.000Z"),
    ];
    const { client } = db(rows);
    const out = await readPartyLines(client, {
      account: "owner_payable", partyId: "owner:own-1", workspaceId: "ws-1",
      fromIso: "2026-01-01T08:00:00.000Z", toIso: "2027-01-01T08:00:00.000Z",
    });
    expect(out.map((row) => row.journalId)).toEqual(["j-9999"]);
  });

  it("returns the lines oldest first", async () => {
    const rows = [line(2, "2026-03-01T00:00:00.000Z"), line(1, "2026-01-01T00:00:00.000Z"), line(3, "2026-02-01T00:00:00.000Z")];
    const { client } = db(rows);
    const out = await readPartyLines(client, { account: "owner_payable", partyId: "owner:own-1" });
    expect(out.map((row) => row.postedAt)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
    ]);
  });
});
