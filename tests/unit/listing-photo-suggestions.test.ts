import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-notify.server", () => ({
  notifyManagerFromAgent: vi.fn(async () => ({ delivered: true, suppressed: false })),
}));

import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import {
  loadSenderRecentImages,
  loadSuggestionFiles,
  recordListingPhotoSuggestion,
  suggestionIdFor,
  verifiedPhoneOfActor,
} from "@/lib/listing-photo-suggestions.server";

type Row = Record<string, unknown>;

/** A tiny supabase stand-in for `sms_media_files` / `profiles` that honours the filters these loaders use. */
function fakeDb(tables: Record<string, Row[]>) {
  const updates: Array<{ table: string; values: Row; ids: unknown[] }> = [];
  const touched = new Set<string>();
  const db = {
    from(table: string) {
      touched.add(table);
      const preds: Array<(r: Row) => boolean> = [];
      let limitN = 1000;
      let pendingUpdate: Row | null = null;
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), q),
        is: (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), q),
        gte: (c: string, v: string) => (preds.push((r) => String(r[c]) >= v), q),
        like: (c: string, v: string) => {
          const prefix = v.replace(/%$/, "");
          preds.push((r) => String(r[c]).startsWith(prefix));
          return q;
        },
        in: (c: string, vals: unknown[]) => {
          if (pendingUpdate) updates.push({ table, values: pendingUpdate, ids: vals });
          preds.push((r) => vals.includes(r[c]));
          return q;
        },
        order: () => q,
        limit: (n: number) => ((limitN = n), q),
        update: (values: Row) => ((pendingUpdate = values), q),
        maybeSingle: async () => ({ data: (tables[table] ?? []).find((r) => preds.every((p) => p(r))) ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null }) => void) =>
          resolve({ data: (tables[table] ?? []).filter((r) => preds.every((p) => p(r))).slice(0, limitN), error: null }),
      };
      return q;
    },
  };
  return { db: db as never, updates, touched };
}

const NOW = new Date("2026-11-23T20:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const file = (id: string, over: Row = {}): Row => ({
  id,
  message_sid: `SM${id}`,
  media_index: 0,
  workspace_id: null,
  sender_phone_key: "2065550101",
  storage_path: `manager/mgr_1/SM${id}-0.jpg`,
  content_type: "image/jpeg",
  byte_size: 1000,
  linked_type: null,
  linked_id: null,
  created_at: minutesAgo(5),
  ...over,
});

describe("loadSenderRecentImages: only the sender's own recent media", () => {
  const rows = [
    file("a"),
    file("b", { sender_phone_key: "2065550199" }), // someone else's phone
    file("c", { created_at: minutesAgo(45) }), // outside the 30 minute window
    file("d", { linked_type: "work_order", linked_id: "wo1" }), // already used elsewhere
    file("e", { content_type: "application/pdf" }), // not a photo
    file("f", { storage_path: "manager/mgr_2/SMf-0.jpg" }), // another manager's number
  ];

  it("returns this phone's unlinked, recent images under the manager it texted", async () => {
    const { db } = fakeDb({ sms_media_files: rows });
    const out = await loadSenderRecentImages(db, { senderPhoneE164: "+12065550101", managerUserId: "mgr_1", now: NOW });
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });

  it("a manager's own photos are bound by phone alone (the number's owner may differ from the actor)", async () => {
    const { db } = fakeDb({ sms_media_files: rows });
    const out = await loadSenderRecentImages(db, { senderPhoneE164: "(206) 555-0101", now: NOW });
    expect(out.map((r) => r.id)).toEqual(["a", "f"]);
  });

  it("refuses an unusable phone or a path-shaped manager id", async () => {
    const { db } = fakeDb({ sms_media_files: rows });
    expect(await loadSenderRecentImages(db, { senderPhoneE164: "nope", now: NOW })).toEqual([]);
    expect(await loadSenderRecentImages(db, { senderPhoneE164: "+12065550101", managerUserId: "../x", now: NOW })).toEqual([]);
  });

  it("verifiedPhoneOfActor needs a verified profile phone", async () => {
    const { db } = fakeDb({
      profiles: [
        { id: "u1", phone: "+12065550101", phone_verified_at: "2026-01-01T00:00:00Z" },
        { id: "u2", phone: "+12065550102", phone_verified_at: null },
      ],
    });
    expect(await verifiedPhoneOfActor(db, "u1")).toBe("+12065550101");
    expect(await verifiedPhoneOfActor(db, "u2")).toBeNull();
    expect(await verifiedPhoneOfActor(db, "u3")).toBeNull();
  });

  it("loadSuggestionFiles reads a suggestion only under the manager's own bucket path", async () => {
    const tagged = [
      file("a", { linked_type: "listing", linked_id: "suggested:abc123def0" }),
      file("g", { linked_type: "listing", linked_id: "suggested:abc123def0", storage_path: "manager/mgr_2/SMg-0.jpg" }),
    ];
    const { db } = fakeDb({ sms_media_files: tagged });
    const out = await loadSuggestionFiles(db, { managerUserId: "mgr_1", suggestionId: "abc123def0" });
    expect(out.map((r) => r.id)).toEqual(["a"]);
    expect(await loadSuggestionFiles(db, { managerUserId: "mgr_1", suggestionId: "not-hex!" })).toEqual([]);
  });
});

describe("recordListingPhotoSuggestion: a resident never writes the listing", () => {
  it("tags the photos, notifies the manager with signed-route links, and touches no listing table", async () => {
    const { db, touched } = fakeDb({ sms_media_files: [file("a"), file("b", { media_index: 1, storage_path: "manager/mgr_1/SMb-1.jpg" })] });
    const result = await recordListingPhotoSuggestion(db, {
      senderPhoneE164: "+12065550101",
      managerUserId: "mgr_1",
      residentUserId: "res_1",
      residentName: "Sam",
      note: "5257, my room",
      origin: "https://example.test",
      now: NOW,
    });
    expect(result).toMatchObject({ ok: true, count: 2, notified: true });
    const call = vi.mocked(notifyManagerFromAgent).mock.calls.at(-1)![1];
    expect(call.landlordId).toBe("mgr_1");
    expect(call.text).toContain("Sam sent 2 photos");
    expect(call.text).toContain("https://example.test/api/sms-media");
    expect(call.text).toContain(`place suggestion ${suggestionIdFor("res_1", [{ id: "a" }, { id: "b" }])}`);
    // The only tables read are the media index; no property / listing record is read or written.
    expect([...touched].filter((t) => t !== "sms_media_files")).toEqual([]);
  });

  it("with no recent photos from this resident it sends nothing", async () => {
    const { db } = fakeDb({ sms_media_files: [file("b", { sender_phone_key: "2065550199" })] });
    vi.mocked(notifyManagerFromAgent).mockClear();
    const result = await recordListingPhotoSuggestion(db, {
      senderPhoneE164: "+12065550101",
      managerUserId: "mgr_1",
      residentUserId: "res_1",
      residentName: "Sam",
      note: "",
      origin: "https://example.test",
      now: NOW,
    });
    expect(result).toEqual({ ok: false, error: "no_photos" });
    expect(notifyManagerFromAgent).not.toHaveBeenCalled();
  });
});
