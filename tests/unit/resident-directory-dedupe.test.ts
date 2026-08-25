// Reported: one person (sohanvnaik@gmail.com) showed up as TWO residents — Room 1 and Room 6 —
// because the Residents list is derived 1:1 from approved application rows. Applications may
// legitimately repeat per person; the RESIDENT identity may not.
import { describe, expect, it } from "vitest";
import { dedupeResidentsByEmail, residentRowWins } from "@/lib/resident-directory-dedupe";

const row = (over: Partial<Parameters<typeof residentRowWins>[0]> & { id: string }) => ({
  email: "sohanvnaik@gmail.com",
  leaseStart: "2026-09-15",
  isPrevious: false,
  ...over,
});

describe("resident directory dedupe", () => {
  it("collapses the reported duplicate to one row", () => {
    const rows = [
      row({ id: "app-room-1", leaseStart: "2026-09-15" }),
      row({ id: "app-room-6", leaseStart: "2026-09-22" }),
    ];
    const out = dedupeResidentsByEmail(rows);
    expect(out).toHaveLength(1);
    // The later placement is the one in force after a room move.
    expect(out[0]!.id).toBe("app-room-6");
  });

  it("is case- and whitespace-insensitive about the address", () => {
    const out = dedupeResidentsByEmail([
      row({ id: "a", email: "Sohan@Gmail.com" }),
      row({ id: "b", email: "  sohan@gmail.com " }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("keeps a CURRENT resident over a previous one, whatever the dates say", () => {
    // A past tenancy with a later start must never hide the live one.
    const out = dedupeResidentsByEmail([
      row({ id: "current", leaseStart: "2026-01-01", isPrevious: false }),
      row({ id: "past", leaseStart: "2026-12-01", isPrevious: true }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["current"]);
  });

  it("NEVER merges rows that have no email", () => {
    // Manually added residents can have no address on file. Treating "" as a shared key would
    // collapse unrelated people into one row — losing real residents, which is worse than a
    // duplicate.
    const out = dedupeResidentsByEmail([
      row({ id: "manual-1", email: "" }),
      row({ id: "manual-2", email: "   " }),
      row({ id: "manual-3", email: "" }),
    ]);
    expect(out).toHaveLength(3);
  });

  it("leaves different people alone", () => {
    const out = dedupeResidentsByEmail([
      row({ id: "a", email: "one@example.com" }),
      row({ id: "b", email: "two@example.com" }),
      row({ id: "c", email: "three@example.com" }),
    ]);
    expect(out).toHaveLength(3);
  });

  it("preserves the caller's ordering for surviving rows", () => {
    const out = dedupeResidentsByEmail([
      row({ id: "z", email: "z@example.com" }),
      row({ id: "dupe-old", email: "dup@example.com", leaseStart: "2026-01-01" }),
      row({ id: "a", email: "a@example.com" }),
      row({ id: "dupe-new", email: "dup@example.com", leaseStart: "2026-06-01" }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["z", "a", "dupe-new"]);
  });

  it("prefers a row WITH a lease start over one without", () => {
    expect(residentRowWins(row({ id: "dated" }), row({ id: "undated", leaseStart: "" }))).toBe(true);
    expect(residentRowWins(row({ id: "undated", leaseStart: "" }), row({ id: "dated" }))).toBe(false);
  });

  it("is deterministic when rows are otherwise identical", () => {
    const a = [row({ id: "aaa" }), row({ id: "bbb" })];
    const b = [row({ id: "bbb" }), row({ id: "aaa" })];
    expect(dedupeResidentsByEmail(a)[0]!.id).toBe(dedupeResidentsByEmail(b)[0]!.id);
  });
});
