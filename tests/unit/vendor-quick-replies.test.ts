// Vendor quick replies (vendor-portal-redesign-1006): each vendor's own saved
// messages, seeded with a starter set, stored on the vendor account's per-user
// JSON row and written only through a route pinned to the signed-in vendor.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VENDOR_QUICK_REPLY_MAX_COUNT,
  VENDOR_QUICK_REPLY_MAX_LENGTH,
  VENDOR_QUICK_REPLY_STARTERS,
  addVendorQuickReply,
  deleteVendorQuickReply,
  editVendorQuickReply,
  insertQuickReplyText,
  moveVendorQuickReply,
  normalizeVendorQuickReplies,
  starterVendorQuickReplies,
} from "@/lib/vendor-quick-replies";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("starter set", () => {
  it("is the approved five, in order", () => {
    expect(VENDOR_QUICK_REPLY_STARTERS).toEqual([
      "On my way",
      "Running 15 minutes late",
      "Need photos of the issue",
      "Can I come by for an estimate?",
      "Job complete — invoice sent",
    ]);
    const starters = starterVendorQuickReplies();
    expect(starters.map((r) => r.text)).toEqual([...VENDOR_QUICK_REPLY_STARTERS]);
    expect(new Set(starters.map((r) => r.id)).size).toBe(5);
  });
});

describe("normalizeVendorQuickReplies", () => {
  it("returns null for anything that is not a list, so 'never saved' differs from 'saved empty'", () => {
    expect(normalizeVendorQuickReplies(undefined)).toBeNull();
    expect(normalizeVendorQuickReplies({})).toBeNull();
    expect(normalizeVendorQuickReplies([])).toEqual([]);
  });

  it("trims, drops empties, caps length and count, and keeps ids unique", () => {
    const long = "x".repeat(VENDOR_QUICK_REPLY_MAX_LENGTH + 50);
    const out = normalizeVendorQuickReplies([
      { id: "a", text: "  hello  " },
      { id: "a", text: "duplicate id" },
      { id: "b", text: "   " },
      { id: "c", text: long },
      "bare string",
      42,
      null,
    ])!;
    expect(out.map((r) => r.text)).toEqual(["hello", "duplicate id", long.slice(0, VENDOR_QUICK_REPLY_MAX_LENGTH), "bare string"]);
    expect(new Set(out.map((r) => r.id)).size).toBe(out.length);

    const many = normalizeVendorQuickReplies(Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, text: `t${i}` })))!;
    expect(many).toHaveLength(VENDOR_QUICK_REPLY_MAX_COUNT);
  });
});

describe("add / edit / delete / reorder", () => {
  const base = [
    { id: "a", text: "one" },
    { id: "b", text: "two" },
    { id: "c", text: "three" },
  ];

  it("adds to the end and edits in place", () => {
    const added = addVendorQuickReply(base, "four");
    expect(added.map((r) => r.text)).toEqual(["one", "two", "three", "four"]);
    expect(editVendorQuickReply(base, "b", "TWO").map((r) => r.text)).toEqual(["one", "TWO", "three"]);
  });

  it("deletes by id", () => {
    expect(deleteVendorQuickReply(base, "b").map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("moves up and down, and a move off either end is a no-op", () => {
    expect(moveVendorQuickReply(base, "c", -1).map((r) => r.id)).toEqual(["a", "c", "b"]);
    expect(moveVendorQuickReply(base, "a", 1).map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(moveVendorQuickReply(base, "a", -1)).toBe(base);
    expect(moveVendorQuickReply(base, "c", 1)).toBe(base);
  });
});

describe("insertQuickReplyText", () => {
  it("fills an empty draft and appends on a new line to a typed one, never overwriting", () => {
    expect(insertQuickReplyText("", "On my way")).toBe("On my way");
    expect(insertQuickReplyText("   ", "On my way")).toBe("On my way");
    expect(insertQuickReplyText("Hi there", "On my way")).toBe("Hi there\nOn my way");
    expect(insertQuickReplyText("Hi there  \n", "On my way")).toBe("Hi there\nOn my way");
  });
  it("respects a field's max length", () => {
    expect(insertQuickReplyText("", "On my way", 5)).toBe("On my");
  });
});

/** A tiny in-memory stand-in for the `notification_preferences` table. */
function fakeDb(initial: Record<string, Record<string, unknown>> = {}) {
  const rows = new Map(Object.entries(initial).map(([userId, row_data]) => [userId, { user_id: userId, row_data }]));
  const writes: unknown[] = [];
  const db = {
    from(table: string) {
      expect(table).toBe("notification_preferences");
      let userId = "";
      const q = {
        select: () => q,
        eq: (_col: string, value: string) => {
          userId = value;
          return q;
        },
        maybeSingle: async () => ({ data: rows.get(userId) ?? null, error: null }),
        upsert: async (row: { user_id: string; row_data: Record<string, unknown> }) => {
          writes.push(row);
          rows.set(row.user_id, row);
          return { error: null };
        },
      };
      return q;
    },
  };
  return { db: db as never, rows, writes };
}

describe("server load/save (notification_preferences.row_data.vendorQuickReplies)", () => {
  it("serves the starter set until the vendor saves their own", async () => {
    const { loadVendorQuickReplies } = await import("@/lib/vendor-quick-replies.server");
    const { db } = fakeDb();
    const result = await loadVendorQuickReplies(db, "vendor-1");
    expect(result.isStarterSet).toBe(true);
    expect(result.replies.map((r) => r.text)).toEqual([...VENDOR_QUICK_REPLY_STARTERS]);
  });

  it("saves only its own key and preserves every sibling in the row", async () => {
    const { loadVendorQuickReplies, saveVendorQuickReplies } = await import("@/lib/vendor-quick-replies.server");
    const { db, rows } = fakeDb({ "vendor-1": { vendor: { topics: { payments: true } }, resident: { quiet: 1 } } });
    await saveVendorQuickReplies(db, "vendor-1", [{ id: "a", text: "Be right there" }]);
    const row = rows.get("vendor-1")!.row_data;
    expect(row.vendor).toEqual({ topics: { payments: true } });
    expect(row.resident).toEqual({ quiet: 1 });
    const loaded = await loadVendorQuickReplies(db, "vendor-1");
    expect(loaded.isStarterSet).toBe(false);
    expect(loaded.replies).toEqual([{ id: "a", text: "Be right there" }]);
  });

  it("an empty saved list stays empty (the vendor deleted every reply) rather than reverting to starters", async () => {
    const { loadVendorQuickReplies, saveVendorQuickReplies } = await import("@/lib/vendor-quick-replies.server");
    const { db } = fakeDb();
    await saveVendorQuickReplies(db, "vendor-1", []);
    expect((await loadVendorQuickReplies(db, "vendor-1")).replies).toEqual([]);
  });

  it("keeps one vendor's replies away from another's", async () => {
    const { loadVendorQuickReplies, saveVendorQuickReplies } = await import("@/lib/vendor-quick-replies.server");
    const { db } = fakeDb();
    await saveVendorQuickReplies(db, "vendor-1", [{ id: "a", text: "mine" }]);
    expect((await loadVendorQuickReplies(db, "vendor-2")).isStarterSet).toBe(true);
  });

  it("refuses a payload that is not a list", async () => {
    const { saveVendorQuickReplies } = await import("@/lib/vendor-quick-replies.server");
    const { db } = fakeDb();
    await expect(saveVendorQuickReplies(db, "vendor-1", { replies: "x" })).rejects.toThrow("Invalid quick replies.");
  });
});

describe("route and neighbours", () => {
  it("the route resolves the vendor from the session and never reads an id from the request", () => {
    const route = read("src/app/api/vendor/quick-replies/route.ts");
    expect(route).toContain("resolveVendorPortalUserId");
    expect(route).toContain("auth.userId");
    expect(route).not.toMatch(/searchParams|params\.|body\.(userId|vendorId|user_id)/);
  });

  it("a notification-category save does not wipe the quick replies beside it", () => {
    expect(read("src/lib/notification-preferences.ts")).toContain('"vendorQuickReplies"');
  });

  it("needs no migration: it rides the existing per-user JSON row", () => {
    expect(read("src/lib/vendor-quick-replies.server.ts")).toContain('from("notification_preferences")');
  });
});
