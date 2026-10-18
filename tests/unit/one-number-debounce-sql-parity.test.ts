import { describe, expect, it } from "vitest";
import { debounceSqlPort } from "../helpers/debounce-sql-port";

/**
 * The expected values below were recorded from the REAL functions on the dev database
 * (emstjswhotsnyksqhqyf, 2026-10-18, inside a rolled-back transaction):
 *   register A -> 1, register A again -> 1, B -> 2, C -> 3, claim 1 -> null, claim 2 -> null,
 *   claim 3 -> [A, B, C], settle 3 -> entries [], register D -> 4, claim 4 -> [D], claim on an unknown scope -> null.
 */
describe("the debounce SQL port behaves like the SQL", () => {
  it("replays the recorded sequence", async () => {
    const db = debounceSqlPort();
    const s = "w18:scope:1";
    const reg = async (sid: string, body: string) => (await db.rpc("sms_debounce_register", { p_scope: s, p_sid: sid, p_body: body })).data;
    const claim = async (scope: string, rev: number) => (await db.rpc("sms_debounce_claim", { p_scope: scope, p_rev: rev })).data as Array<{ sid: string; rev: number; body: string }> | null;
    expect(await reg("A", "hey")).toBe(1);
    expect(await reg("A", "hey")).toBe(1);
    expect(await reg("B", "quick question")).toBe(2);
    expect(await reg("C", "is the wifi down")).toBe(3);
    expect(await claim(s, 1)).toBeNull();
    expect(await claim(s, 2)).toBeNull();
    expect((await claim(s, 3))!.map((e) => [e.rev, e.sid, e.body])).toEqual([[1, "A", "hey"], [2, "B", "quick question"], [3, "C", "is the wifi down"]]);
    await db.rpc("sms_debounce_settle", { p_scope: s, p_rev: 3 });
    expect(db.table.get(s)!.entries).toEqual([]);
    expect(await reg("D", "thanks")).toBe(4);
    expect((await claim(s, 4))!.map((e) => [e.rev, e.sid])).toEqual([[4, "D"]]);
    expect(await claim("w18:scope:none", 1)).toBeNull();
  });

  it("drops texts older than 90 seconds when a new one registers, and rejects an empty scope", async () => {
    let t = 1_000_000;
    const db = debounceSqlPort(() => t);
    await db.rpc("sms_debounce_register", { p_scope: "s", p_sid: "old", p_body: "x" });
    t += 91_000;
    await db.rpc("sms_debounce_register", { p_scope: "s", p_sid: "new", p_body: "y" });
    expect(db.table.get("s")!.entries.map((e) => e.sid)).toEqual(["new"]);
    expect((await db.rpc("sms_debounce_register", { p_scope: "", p_sid: "z", p_body: "" })).error).not.toBeNull();
  });
});
