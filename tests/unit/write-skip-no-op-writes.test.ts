import { describe, expect, it } from "vitest";
import { jsonEqual, sameUnorderedList, shouldRestamp, stableStringify } from "@/lib/write-skip";
import { filterNewReminderRows } from "@/lib/reminders/queue.server";
import { householdChargeRowUnchanged } from "@/lib/household-charges.server";
import { shouldStampExportFetch } from "@/lib/channel-calendar/export-fetch-stamp";

describe("write-skip helpers", () => {
  it("compares JSON regardless of key order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
    expect(jsonEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(jsonEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });

  it("treats a re-ordered set of ranges as unchanged", () => {
    expect(sameUnorderedList([{ s: 1 }, { s: 2 }], [{ s: 2 }, { s: 1 }])).toBe(true);
    expect(sameUnorderedList([{ s: 1 }], [{ s: 1 }, { s: 2 }])).toBe(false);
  });

  it("restamps only when changed, missing, or older than the interval", () => {
    const now = new Date("2026-11-23T12:00:00Z");
    const recent = new Date(now.getTime() - 5 * 60_000).toISOString();
    const old = new Date(now.getTime() - 20 * 60_000).toISOString();
    expect(shouldRestamp({ lastStampIso: recent, now, changed: false })).toBe(false);
    expect(shouldRestamp({ lastStampIso: old, now, changed: false })).toBe(true);
    expect(shouldRestamp({ lastStampIso: recent, now, changed: true })).toBe(true);
    expect(shouldRestamp({ lastStampIso: null, now, changed: false })).toBe(true);
  });
});

describe("reminder materialize delta", () => {
  it("keeps only rows whose dedupe key is not queued", () => {
    const rows = [{ dedupe_key: "a" }, { dedupe_key: "b" }, { dedupe_key: "c" }];
    expect(filterNewReminderRows(rows, new Set(["a", "c"]))).toEqual([{ dedupe_key: "b" }]);
    expect(filterNewReminderRows(rows, new Set(["a", "b", "c"]))).toEqual([]);
  });
});

describe("household charge no-op", () => {
  const next = {
    manager_user_id: "m", resident_user_id: "r", resident_email: "a@b.c", property_id: "p",
    kind: "rent", status: "pending", row_data: { id: "1", amount: 10, nested: { x: 1, y: 2 } },
  };
  it("skips an identical row and writes a changed or new one", () => {
    expect(householdChargeRowUnchanged({ ...next, row_data: { nested: { y: 2, x: 1 }, amount: 10, id: "1" } }, next)).toBe(true);
    expect(householdChargeRowUnchanged({ ...next, status: "paid" }, next)).toBe(false);
    expect(householdChargeRowUnchanged({ ...next, row_data: { ...next.row_data, amount: 11 } }, next)).toBe(false);
    expect(householdChargeRowUnchanged(undefined, next)).toBe(false);
  });
});

describe("export fetch stamp throttle", () => {
  it("is accurate to about 15 minutes", () => {
    const now = new Date("2026-11-23T12:00:00Z");
    const ua = "Airbnb/1.0";
    expect(shouldStampExportFetch({ userAgent: ua, lastFetchedAt: new Date(now.getTime() - 10 * 60_000).toISOString(), now })).toBe(false);
    expect(shouldStampExportFetch({ userAgent: ua, lastFetchedAt: new Date(now.getTime() - 16 * 60_000).toISOString(), now })).toBe(true);
  });
});
