import { describe, expect, it } from "vitest";
import { refreshedPageCursor } from "@/lib/sms-paged-head";

type Row = { id: string; createdAt: string };
const row = (id: number, createdAt = "2026-09-26T00:00:00Z"): Row => ({ id: String(id).padStart(3, "0"), createdAt });
const idOf = (item: Row) => item.id;
const numbers = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, index) => row(start + index));

describe("SMS refreshed page continuity", () => {
  it.each(["main transcript", "resident detail transcript"])("restores the missing 51st turn in the %s", () => {
    const loaded = numbers(1, 50);
    const fresh = numbers(52, 101);
    const freshCursor = "before-052";
    const result = refreshedPageCursor(fresh, loaded, freshCursor, null, idOf);
    expect(result).toEqual({ overlaps: false, nextCursor: "before-052" });
    expect(fresh.some((item) => item.id === row(51).id)).toBe(false);
  });

  it("keeps overlapping transcript pages, including timestamp ties", () => {
    const loaded = numbers(1, 70);
    const fresh = numbers(66, 115);
    expect(refreshedPageCursor(fresh, loaded, "new-boundary", "old-boundary", idOf)).toEqual({ overlaps: true, nextCursor: "old-boundary" });
    expect(refreshedPageCursor([row(116)], loaded, "new-boundary", "old-boundary", idOf)).toEqual({ overlaps: false, nextCursor: "new-boundary" });
  });
});
