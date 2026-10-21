// The in-app house chat's storage and sync: one chat per house created only through the conversation key,
// membership recomputed from occupancy, "Welcome" lines for joiners, silent removal of leavers, and the
// move-out archive of a resident's one-on-one conversations (idempotent, never while another residency remains).
import { describe, expect, it } from "vitest";

import { archiveMovedOutConversations, syncHouseChat } from "@/lib/house-chat/sync.server";
import { ensureHouseThread, loadHouseThread } from "@/lib/house-chat/store.server";
import { readHouseChatState } from "@/lib/house-chat/model";
import { houseThreadId } from "@/lib/house-thread-id";
import { OTHER_HOUSE, HOUSE, MANAGER_SCOPE, NOON, OWNER, RESIDENT_SCOPE, TODAY, WS, chatDb, leaseStay, oneOnOne, threadRows } from "../helpers/house-chat-fixtures";

const base = { workspaceId: WS, ownerUserId: OWNER, propertyId: HOUSE, houseLabel: "12 Pine St" };
const THREAD = houseThreadId(OWNER, WS, HOUSE);
const MAYA = leaseStay("maya@example.com", "Maya Lopez");
const NOAH = leaseStay("noah@example.com", "Noah Kim", { roomLabel: "Room 2", start: "2026-06-05" });
const PRIYA = leaseStay("priya@example.com", "Priya Rao", { roomLabel: "Room 3", start: "2026-10-01" });

const lines = (db: ReturnType<typeof chatDb>) =>
  ((threadRows(db).find((r) => r.id === THREAD)?.row_data as { messages?: { body: string; system?: boolean }[] })?.messages ?? []).map((m) => m.body);

describe("ensureHouseThread", () => {
  it("creates one chat per house under the house key, and a second or concurrent call finds it", async () => {
    const db = chatDb();
    const [a, b] = await Promise.all([ensureHouseThread(db.db, base), ensureHouseThread(db.db, base)]);
    const c = await ensureHouseThread(db.db, base);
    expect([a, b, c]).toEqual([THREAD, THREAD, THREAD]);
    const rows = threadRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: THREAD, scope: MANAGER_SCOPE, owner_user_id: OWNER, workspace_id: WS, thread_type: "house", conversation_key: `house:${HOUSE}` });
    expect((rows[0]!.row_data as { subject: string }).subject).toBe("House · 12 Pine St");
  });

  it("goes through the database function, never a bare insert", async () => {
    const db = chatDb();
    await ensureHouseThread(db.db, base);
    expect(db.log.some((entry) => entry.table === "rpc:resolve_or_create_conversation")).toBe(true);
    expect(db.log.some((entry) => entry.table === "portal_inbox_thread_records" && entry.op === "insert")).toBe(false);
  });
});

describe("syncHouseChat", () => {
  it("makes no chat for a house nobody lives in", async () => {
    const db = chatDb();
    const result = await syncHouseChat(db.db, base, { stays: [], now: () => NOON });
    expect(result.outcome).toBe("no_residents");
    expect(threadRows(db)).toHaveLength(0);
  });

  it("creates the chat, welcomes the residents once, and a second run changes nothing", async () => {
    const db = chatDb();
    const first = await syncHouseChat(db.db, base, { stays: [MAYA, NOAH], now: () => NOON });
    expect(first).toMatchObject({ outcome: "created", joined: 2, left: 0 });
    expect(lines(db)).toEqual(["Welcome Maya and Noah"]);
    const stored = await loadHouseThread(db.db, THREAD);
    expect(readHouseChatState(stored!.rowData).residents.map((r) => r.email)).toEqual(["maya@example.com", "noah@example.com"]);

    const second = await syncHouseChat(db.db, base, { stays: [MAYA, NOAH], now: () => NOON });
    expect(second.outcome).toBe("unchanged");
    expect(lines(db)).toEqual(["Welcome Maya and Noah"]);
    expect(threadRows(db)).toHaveLength(1);
  });

  it("welcomes a joiner by first name and drops a leaver with no announcement", async () => {
    const db = chatDb();
    await syncHouseChat(db.db, base, { stays: [MAYA, NOAH], now: () => NOON });
    const joined = await syncHouseChat(db.db, base, { stays: [MAYA, NOAH, PRIYA], now: () => NOON });
    expect(joined).toMatchObject({ outcome: "updated", joined: 1, left: 0 });
    expect(lines(db)).toEqual(["Welcome Maya and Noah", "Welcome Priya"]);

    const noahLeaves = leaseStay("noah@example.com", "Noah Kim", { roomLabel: "Room 2", end: "2026-10-18" });
    const left = await syncHouseChat(db.db, base, { stays: [MAYA, noahLeaves, PRIYA], now: () => NOON });
    expect(left).toMatchObject({ outcome: "updated", joined: 0, left: 1 });
    expect(lines(db)).toEqual(["Welcome Maya and Noah", "Welcome Priya"]);
    const stored = await loadHouseThread(db.db, THREAD);
    expect(readHouseChatState(stored!.rowData).residents.map((r) => r.email)).toEqual(["maya@example.com", "priya@example.com"]);
  });

  it("keeps the chat but empties its roster when the last resident leaves", async () => {
    const db = chatDb();
    await syncHouseChat(db.db, base, { stays: [MAYA], now: () => NOON });
    const gone = leaseStay("maya@example.com", "Maya Lopez", { end: "2026-10-10" });
    const result = await syncHouseChat(db.db, base, { stays: [gone], now: () => NOON });
    expect(result.outcome).toBe("updated");
    expect(readHouseChatState((await loadHouseThread(db.db, THREAD))!.rowData).residents).toEqual([]);
  });
});

describe("archiveMovedOutConversations", () => {
  const OLD = leaseStay("old@example.com", "Olive Old", { end: "2026-10-15" });

  function seeded() {
    return chatDb({
      profiles: [
        { id: "user-old", email: "old@example.com" },
        { id: "user-maya", email: "maya@example.com" },
      ],
      portal_inbox_thread_records: [
        oneOnOne("mgr-old", MANAGER_SCOPE, OWNER, "acct:user-old"),
        oneOnOne("mgr-old-mail", MANAGER_SCOPE, OWNER, "mail:old@example.com", { folder: "sent" }),
        oneOnOne("res-old", RESIDENT_SCOPE, "user-old", `ws:${WS}`),
        oneOnOne("mgr-maya", MANAGER_SCOPE, OWNER, "acct:user-maya"),
        { ...oneOnOne("assistant", MANAGER_SCOPE, OWNER, "acct:user-old"), thread_type: "agent_notice" },
        { ...oneOnOne(`team-thread:${OWNER}:ws:${WS}`, MANAGER_SCOPE, OWNER, "acct:user-old"), thread_type: "team" },
      ],
    });
  }
  const folderOf = (db: ReturnType<typeof chatDb>, id: string) => (threadRows(db).find((r) => r.id === id)!.row_data as { folder: string }).folder;
  const run = (db: ReturnType<typeof chatDb>, stays = [OLD, MAYA]) =>
    archiveMovedOutConversations(db.db, { workspaceId: WS, ownerUserId: OWNER, stays, today: TODAY });

  it("moves the resident's one-on-one conversations to Archived on both sides and touches nothing else", async () => {
    const db = seeded();
    const result = await run(db);
    expect(result).toEqual({ residents: 1, archived: 3, errors: 0 });
    expect(folderOf(db, "mgr-old")).toBe("trash");
    expect(folderOf(db, "mgr-old-mail")).toBe("trash");
    expect(folderOf(db, "res-old")).toBe("trash");
    expect(folderOf(db, "mgr-maya")).toBe("inbox");
    expect(folderOf(db, "assistant")).toBe("inbox");
    expect(folderOf(db, `team-thread:${OWNER}:ws:${WS}`)).toBe("inbox");
  });

  it("is idempotent, and a conversation the manager restored stays restored", async () => {
    const db = seeded();
    await run(db);
    expect(await run(db)).toMatchObject({ archived: 0 });
    const restored = threadRows(db).find((r) => r.id === "mgr-old")!;
    restored.row_data = { ...(restored.row_data as object), folder: "inbox" };
    expect(await run(db)).toMatchObject({ archived: 0 });
    expect(folderOf(db, "mgr-old")).toBe("inbox");
  });

  it("archives again after a LATER move-out", async () => {
    const db = seeded();
    await run(db);
    const restored = threadRows(db).find((r) => r.id === "mgr-old")!;
    restored.row_data = { ...(restored.row_data as object), folder: "inbox" };
    const later = leaseStay("old@example.com", "Olive Old", { start: "2026-10-16", end: "2026-10-19", propertyId: OTHER_HOUSE });
    // A second, short-lived stay does not count (short stay); a long one ending later does.
    const longer = leaseStay("old@example.com", "Olive Old", { start: "2026-08-01", end: "2026-10-19", propertyId: OTHER_HOUSE });
    expect(await run(db, [OLD, later, MAYA])).toMatchObject({ archived: 0 });
    expect(await run(db, [OLD, longer, MAYA])).toMatchObject({ archived: 1 });
    expect(folderOf(db, "mgr-old")).toBe("trash");
  });

  it("never archives a resident who still has another current residency in the workspace", async () => {
    const db = seeded();
    const otherHouse = leaseStay("old@example.com", "Olive Old", { propertyId: OTHER_HOUSE, start: "2026-09-01", end: "2027-08-31" });
    const result = await run(db, [OLD, otherHouse, MAYA]);
    expect(result).toMatchObject({ residents: 0, archived: 0 });
    expect(folderOf(db, "mgr-old")).toBe("inbox");
    expect(folderOf(db, "res-old")).toBe("inbox");
  });
});
