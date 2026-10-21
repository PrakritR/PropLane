// Who may read or post in a house chat, and what a post does: membership is re-derived from the thread id and
// the occupancy snapshot on every call (a moved-out resident or a stranger is refused), a resident is drawn as
// "First · Room", nothing identifying reaches another viewer, and archive is the viewer's own.
import { describe, expect, it } from "vitest";

import { assertHouseThreadAccess } from "@/lib/house-chat/access.server";
import { applyHouseMailboxState, houseRowsForResident } from "@/lib/house-chat/mailbox.server";
import { houseReplyMessageId, postToHouseChat } from "@/lib/house-chat/post.server";
import { houseResidentsFromStays, type HouseResident } from "@/lib/house-chat/model";
import { ensureHouseThread, loadHouseThread } from "@/lib/house-chat/store.server";
import { houseThreadId } from "@/lib/house-thread-id";
import type { CommunicationScope } from "@/lib/communication/conversation-visibility.server";
import { HOUSE, NOON, OWNER, TODAY, WS, chatDb, leaseStay, threadRows } from "../helpers/house-chat-fixtures";
import { syncHouseChat } from "@/lib/house-chat/sync.server";

const THREAD = houseThreadId(OWNER, WS, HOUSE);
const MAYA = leaseStay("maya@example.com", "Maya Lopez", { roomLabel: "Room 2" });
const NOAH = leaseStay("noah@example.com", "Noah Kim", { start: "2026-06-05" });

const residentsOf = (stays: ReturnType<typeof leaseStay>[]): HouseResident[] => houseResidentsFromStays(stays, { propertyId: HOUSE, today: TODAY });

const scopeFor = (viewerId: string, over: Partial<CommunicationScope> = {}): CommunicationScope => ({
  viewerId,
  level: "read",
  ownerIds: [viewerId],
  grantedHousesByOwner: new Map(),
  workspaceHouseIds: null,
  untaggedOwnedVisible: true,
  activeWorkspaceId: WS,
  workspaceByLine: new Map(),
  ...over,
});

function access(input: { userId: string; email: string; level?: "read" | "edit" }, over: { scope?: CommunicationScope; stays?: ReturnType<typeof leaseStay>[]; houseExists?: boolean } = {}) {
  const { db } = chatDb();
  return assertHouseThreadAccess(
    db,
    { threadId: THREAD, userId: input.userId, email: input.email, level: input.level ?? "read" },
    {
      resolveScope: async () => over.scope ?? scopeFor(input.userId),
      residents: async () => residentsOf(over.stays ?? [MAYA, NOAH]),
      houseExists: async () => over.houseExists ?? true,
    },
  );
}

describe("assertHouseThreadAccess", () => {
  it("admits a current resident (by their own login email) to read and post", async () => {
    expect(await access({ userId: "user-maya", email: "Maya@Example.com", level: "read" })).toMatchObject({ ok: true, kind: "resident" });
    expect(await access({ userId: "user-maya", email: "maya@example.com", level: "edit" })).toMatchObject({ ok: true, kind: "resident", canPost: true });
  });

  it("refuses a resident who has moved out, the instant the stay ends", async () => {
    const moved = leaseStay("maya@example.com", "Maya Lopez", { end: "2026-10-19" });
    expect(await access({ userId: "user-maya", email: "maya@example.com" }, { stays: [moved, NOAH] })).toEqual({ ok: false });
    expect(await access({ userId: "user-maya", email: "maya@example.com", level: "edit" }, { stays: [moved, NOAH] })).toEqual({ ok: false });
  });

  it("refuses a stranger, a guest on a short stay, a malformed id and a house outside the workspace", async () => {
    expect(await access({ userId: "user-x", email: "stranger@example.com" })).toEqual({ ok: false });
    const short = leaseStay("guest@example.com", "Gus Guest", { start: "2026-10-10", end: "2026-10-24" });
    expect(await access({ userId: "user-g", email: "guest@example.com" }, { stays: [short] })).toEqual({ ok: false });
    expect(await access({ userId: "user-maya", email: "maya@example.com" }, { houseExists: false })).toEqual({ ok: false });
    const { db } = chatDb();
    expect(await assertHouseThreadAccess(db, { threadId: "house-thread:nope", userId: "u", email: "maya@example.com", level: "read" })).toEqual({ ok: false });
  });

  it("admits the owner, and a teammate only with the workspace membership and the house grant", async () => {
    expect(await access({ userId: OWNER, email: "owner@example.com" }, { scope: scopeFor(OWNER), stays: [] })).toMatchObject({ ok: true, kind: "team" });
    const member = new Map([[OWNER, new Map([[WS, { canPost: true }]])]]);
    const granted = new Map([[OWNER, new Set([HOUSE])]]);
    const mate = (over: Partial<CommunicationScope>) => scopeFor("mate", over);
    expect(await access({ userId: "mate", email: "mate@example.com", level: "edit" }, { scope: mate({ teamWorkspacesByOwner: member, grantedHousesByOwner: granted }), stays: [] })).toMatchObject({ ok: true, kind: "team" });
    expect(await access({ userId: "mate", email: "mate@example.com" }, { scope: mate({ teamWorkspacesByOwner: member }), stays: [] })).toEqual({ ok: false });
    expect(await access({ userId: "mate", email: "mate@example.com" }, { scope: mate({ grantedHousesByOwner: granted }), stays: [] })).toEqual({ ok: false });
  });

  it("lets a Viewer-role teammate read but not post", async () => {
    const viewer = new Map([[OWNER, new Map([[WS, { canPost: false }]])]]);
    const granted = new Map([[OWNER, new Set([HOUSE])]]);
    const scope = scopeFor("mate", { teamWorkspacesByOwner: viewer, grantedHousesByOwner: granted });
    expect(await access({ userId: "mate", email: "mate@example.com", level: "read" }, { scope, stays: [] })).toMatchObject({ ok: true });
    expect(await access({ userId: "mate", email: "mate@example.com", level: "edit" }, { scope, stays: [] })).toEqual({ ok: false });
  });
});

describe("postToHouseChat", () => {
  async function seeded() {
    const db = chatDb();
    await ensureHouseThread(db.db, { workspaceId: WS, ownerUserId: OWNER, propertyId: HOUSE, houseLabel: "12 Pine St" });
    return db;
  }
  const resident = residentsOf([MAYA, NOAH])[0]!;
  const post = (db: Awaited<ReturnType<typeof seeded>>, over: Record<string, unknown> = {}, accessOk = true) =>
    postToHouseChat(
      db.db,
      { threadId: THREAD, userId: "user-maya", email: "maya@example.com", fromName: "Maya Lopez", text: "Trash goes out Tuesday", hasAttachments: false, messageId: "house-reply:user-maya:1", ...over },
      { access: async () => (accessOk ? { ok: true, kind: "resident", parsed: { ownerManagerUserId: OWNER, workspaceId: WS, propertyId: HOUSE }, canPost: true, resident } : { ok: false }) },
    );

  it("appends the line as 'First · Room' with the poster's id, and a retry posts once", async () => {
    const db = await seeded();
    expect(await post(db)).toEqual({ ok: true, posted: true });
    expect(await post(db)).toEqual({ ok: true, posted: false });
    const stored = await loadHouseThread(db.db, THREAD);
    const messages = stored!.rowData.messages as { from: string; body: string; actorUserId?: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ from: `${resident.firstName} · Room 2`, body: "Trash goes out Tuesday", actorUserId: "user-maya" });
  });

  it("answers 403 to a non-member or moved-out resident and stores nothing", async () => {
    const db = await seeded();
    expect(await post(db, {}, false)).toMatchObject({ ok: false, status: 403 });
    expect(((await loadHouseThread(db.db, THREAD))!.rowData.messages as unknown[]).length).toBe(0);
  });

  it("refuses an empty, oversized or attachment post", async () => {
    const db = await seeded();
    expect(await post(db, { text: "  " })).toMatchObject({ ok: false, status: 400 });
    expect(await post(db, { text: "x".repeat(4001) })).toMatchObject({ ok: false, status: 400 });
    expect(await post(db, { hasAttachments: true })).toMatchObject({ ok: false, status: 400 });
  });

  it("stores an opaque message id: no account id, stable for a retry, different per poster", () => {
    const id = houseReplyMessageId("user-maya", "reply-abc");
    expect(id).not.toContain("user-maya");
    expect(id).toBe(houseReplyMessageId("user-maya", "reply-abc"));
    expect(id).not.toBe(houseReplyMessageId("user-noah", "reply-abc"));
  });

  it("sends nothing by text or email: the only writes are to the thread table", async () => {
    const db = await seeded();
    await post(db);
    const tables = new Set(db.log.filter((entry) => !entry.table.startsWith("rpc:")).map((entry) => entry.table));
    expect([...tables]).toEqual(["portal_inbox_thread_records"]);
  });
});

describe("what a housemate sees and per-viewer mailbox state", () => {
  it("lists the chat to a current resident with no other resident's email or id, and not to one who moved out", async () => {
    const db = chatDb();
    await syncHouseChat(db.db, { workspaceId: WS, ownerUserId: OWNER, propertyId: HOUSE, houseLabel: "12 Pine St" }, { stays: [MAYA, NOAH], now: () => NOON });
    await postToHouseChat(
      db.db,
      { threadId: THREAD, userId: "user-noah", email: "noah@example.com", fromName: "Noah Kim", text: "Who has the garage code?", hasAttachments: false, messageId: houseReplyMessageId("user-noah", "t1") },
      { access: async () => ({ ok: true, kind: "resident", parsed: { ownerManagerUserId: OWNER, workspaceId: WS, propertyId: HOUSE }, canPost: true, resident: residentsOf([MAYA, NOAH]).find((r) => r.email === "noah@example.com")! }) },
    );
    const asMaya = { userId: "user-maya", email: "maya@example.com", inboxScope: "axis_portal_inbox_resident_v1" };
    const live = (stays: ReturnType<typeof leaseStay>[]) => ({ residents: async () => residentsOf(stays), houseExists: async () => true });

    const rows = await houseRowsForResident(db.db, asMaya, live([MAYA, NOAH]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: THREAD, subject: "House · 12 Pine St", unread: true });
    const json = JSON.stringify(rows);
    for (const secret of ["noah@example.com", "maya@example.com", "user-noah", "actorUserId", "residents"]) expect(json).not.toContain(secret);
    expect(json).toContain("· Room");

    const moved = leaseStay("maya@example.com", "Maya Lopez", { roomLabel: "Room 2", end: "2026-10-19" });
    expect(await houseRowsForResident(db.db, asMaya, live([moved, NOAH]))).toEqual([]);
    expect(await houseRowsForResident(db.db, { ...asMaya, userId: "user-x", email: "stranger@example.com" }, live([MAYA, NOAH]))).toEqual([]);
  });

  it("archive and read are the viewer's own and never touch another member's view", async () => {
    const db = chatDb();
    await ensureHouseThread(db.db, { workspaceId: WS, ownerUserId: OWNER, propertyId: HOUSE, houseLabel: "12 Pine St" });
    // The owner may read: archive it for the owner only.
    const { db: client } = db;
    const { setHouseViewerState } = await import("@/lib/house-chat/store.server");
    expect(await setHouseViewerState(client, THREAD, OWNER, { folder: "trash", read: true })).toBe(true);
    const state = (await loadHouseThread(client, THREAD))!.rowData.houseChat as { viewerState: Record<string, { folder?: string }> };
    expect(state.viewerState[OWNER]!.folder).toBe("trash");
    expect(state.viewerState["user-maya"]).toBeUndefined();
    // A line posted later pulls it back to Active for everyone.
    const { appendHouseLine } = await import("@/lib/house-chat/store.server");
    await appendHouseLine(client, THREAD, { id: "m", from: "Maya · Room 2", body: "hi", actorUserId: "user-maya" });
    const after = (await loadHouseThread(client, THREAD))!.rowData.houseChat as { viewerState: Record<string, { folder?: string }> };
    expect(after.viewerState[OWNER]!.folder).toBeUndefined();
  });

  it("applyHouseMailboxState skips a chat the viewer cannot read (a stranger changes nothing)", async () => {
    const db = chatDb();
    await ensureHouseThread(db.db, { workspaceId: WS, ownerUserId: OWNER, propertyId: HOUSE, houseLabel: "12 Pine St" });
    const applied = await applyHouseMailboxState(db.db, { userId: "user-x", email: "stranger@example.com" }, [THREAD], { folder: "trash" });
    expect(applied).toBe(0);
    const state = (await loadHouseThread(db.db, THREAD))!.rowData.houseChat as { viewerState: Record<string, unknown> };
    expect(state.viewerState).toEqual({});
  });
});
