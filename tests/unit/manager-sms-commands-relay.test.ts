import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCommandDb } from "../helpers/command-fake-db";
import {
  REPLY_HANDLE_TTL_MS,
  REPLY_HANDLE_WRONG_PER_HOUR,
  mintReplyHandleFor,
  nudgeReply,
  relayReply,
  type RelayDeps,
} from "@/lib/manager-sms-commands/reply-relay.server";

const STAFF = "+12065550142";
const OTHER_STAFF = "+12065550177";
const PROSPECT = "+12065550999";
const T0 = new Date("2026-11-12T18:00:00.000Z");

let db: ReturnType<typeof makeCommandDb>;
let send: ReturnType<typeof vi.fn>;
let recordOutbound: ReturnType<typeof vi.fn>;
let deps: RelayDeps;

function freshDb() {
  return makeCommandDb(
    {
      sms_phone_contacts: [{ phone_key: "2065550999", display_name: "Maya" }],
      portal_inbox_thread_records: [{ id: "thread-1", workspace_id: "ws-1", row_data: { prospectContext: { propertyLabel: "5259 Brooklyn Ave NE, Seattle", roomLabel: "Room 4" } } }],
    },
    { unique: { sms_reply_handles: ["staff_phone_key", "handle"] } },
  );
}

const input = (body: string, over: Record<string, unknown> = {}) => ({
  staffPhoneE164: STAFF, actorUserId: "staff-1", workspaceIds: ["ws-1"], body, messageSid: "SM-relay-1", ...over,
});

beforeEach(() => {
  db = freshDb();
  send = vi.fn(async () => ({ body: { ok: true, status: "submitted" }, status: 200 }));
  recordOutbound = vi.fn(async () => undefined);
  deps = {
    buildContext: async () => ({ landlordId: "owner-1", userId: "staff-1", email: "staff@example.test" }) as never,
    send: send as never,
    recordOutbound: recordOutbound as never,
    editOwnerIds: async () => ["owner-1"],
    now: () => T0,
  };
});

async function mint(thread = "thread-1", staff = STAFF, workspace = "ws-1", at = T0) {
  return mintReplyHandleFor(db as never, { staffPhoneE164: staff, workspaceId: workspace, threadId: thread, counterpartyPhoneE164: PROSPECT }, at);
}

describe("reply handles", () => {
  it("mints a short handle that carries a digit, and repeats it for the same thread", async () => {
    const handle = await mint();
    expect(handle).toMatch(/^[A-Z][A-Z0-9]?\d$/);
    expect(await mint()).toBe(handle);
    expect(db.tables.sms_reply_handles).toHaveLength(1);
    const other = await mint("thread-2");
    expect(other).not.toBe(handle);
  });

  it("is keyed on the staff phone: the same handle can exist for another phone", async () => {
    const a = await mint("thread-1", STAFF);
    await mint("thread-9", OTHER_STAFF);
    expect(db.tables.sms_reply_handles).toHaveLength(2);
    expect(a).toBeTruthy();
  });

  it("clears expired handles of that phone so the pair can be reused", async () => {
    db.tables.sms_reply_handles = [{ id: "old", staff_phone_key: "2065550142", handle: "K7", workspace_id: "ws-1", thread_id: "t-old", counterparty_phone_key: "2065550999", expires_at: new Date(T0.getTime() - 1000).toISOString() }];
    expect(await mint("thread-new")).toBeTruthy();
    expect(db.tables.sms_reply_handles!.some((r) => r.id === "old")).toBe(false);
  });

  it("returns null rather than a handle when the inputs are incomplete", async () => {
    expect(await mintReplyHandleFor(db as never, { staffPhoneE164: "", workspaceId: "ws-1", threadId: "t", counterpartyPhoneE164: PROSPECT }, T0)).toBeNull();
    expect(await mintReplyHandleFor(db as never, { staffPhoneE164: STAFF, workspaceId: "ws-1", threadId: "", counterpartyPhoneE164: PROSPECT }, T0)).toBeNull();
  });
});

describe("relay: K7 <answer>", () => {
  it("sends the answer to that prospect, as the staff member, and logs it in the thread", async () => {
    const handle = (await mint())!;
    const result = await relayReply(db as never, input(`${handle.toLowerCase()} yes Dec 1 works`), deps);
    expect(result).toEqual({ handled: true, reply: "Sent to Maya (5259 Brooklyn Ave NE · Room 4)." });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toMatchObject({
      actorUserId: "staff-1", author: "manager", toPhone: PROSPECT, text: "yes Dec 1 works", scopeManagerIds: ["owner-1"], workspace: { id: "ws-1" },
    });
    expect(recordOutbound).toHaveBeenCalledWith(db, expect.objectContaining({ threadId: "thread-1", workspaceId: "ws-1", body: "yes Dec 1 works", staffUserId: "staff-1", eventId: "relay:SM-relay-1" }));
  });

  it("an expired handle says so and sends nothing", async () => {
    const handle = (await mint(undefined, undefined, undefined, new Date(T0.getTime() - REPLY_HANDLE_TTL_MS - 1000)))!;
    const result = await relayReply(db as never, input(`${handle} ok`), deps);
    expect(result).toMatchObject({ handled: true });
    if (result.handled) expect(result.reply).toContain("expired");
    expect(send).not.toHaveBeenCalled();
  });

  it("a handle held by another staff phone is not this phone's handle", async () => {
    const handle = (await mint("thread-1", OTHER_STAFF))!;
    const result = await relayReply(db as never, input(`${handle} hello there`), deps);
    expect(result).toEqual({ handled: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("is scoped to the workspaces this phone may run", async () => {
    const handle = (await mint("thread-1", STAFF, "ws-secret"))!;
    const result = await relayReply(db as never, input(`${handle} hello`, { workspaceIds: ["ws-1"] }), deps);
    expect(result).toEqual({ handled: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("counts wrong handles and pauses relaying after five an hour, even for a right one", async () => {
    const good = (await mint())!;
    for (let i = 0; i < REPLY_HANDLE_WRONG_PER_HOUR; i += 1) {
      expect(await relayReply(db as never, input("Z9 nope"), deps)).toEqual({ handled: false });
    }
    const locked = await relayReply(db as never, input(`${good} hi`), deps);
    expect(locked).toMatchObject({ handled: true });
    if (locked.handled) expect(locked.reply).toContain("paused");
    expect(send).not.toHaveBeenCalled();
  });

  it("an ordinary first word is never counted as a wrong handle", async () => {
    for (let i = 0; i < 8; i += 1) expect(await relayReply(db as never, input("Hello there friend"), deps)).toEqual({ handled: false });
    expect(db.tables.sms_confirmation_failures ?? []).toHaveLength(0);
  });

  it("reports a refused send instead of claiming success", async () => {
    send.mockResolvedValueOnce({ body: { error: "That number has opted out of texts." }, status: 409 });
    const handle = (await mint())!;
    const result = await relayReply(db as never, input(`${handle} are you still interested`), deps);
    expect(result).toMatchObject({ handled: true });
    if (result.handled) {
      expect(result.reply).toContain("Not sent");
      expect(result.reply).toContain("opted out");
    }
    expect(recordOutbound).not.toHaveBeenCalled();
  });

  it("refuses when the actor holds no write context on that workspace", async () => {
    const handle = (await mint())!;
    const result = await relayReply(db as never, input(`${handle} hi`), { ...deps, buildContext: async () => null });
    expect(result).toMatchObject({ handled: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("a failure to log the turn does not undo a delivered text", async () => {
    recordOutbound.mockRejectedValueOnce(new Error("spine down"));
    const handle = (await mint())!;
    const result = await relayReply(db as never, input(`${handle} see you then`), deps);
    expect(result).toMatchObject({ handled: true, reply: expect.stringContaining("Sent to Maya") });
  });
});

describe("no handle", () => {
  it("one fresh alert and a short answer: asks, never sends", async () => {
    const handle = (await mint())!;
    const result = await nudgeReply(db as never, { staffPhoneE164: STAFF, body: "Yes Dec 1 works" }, T0);
    expect(result).toEqual({ handled: true, reply: `Reply to Maya (5259 Brooklyn Ave NE · Room 4)? Send: ${handle} <message>` });
    expect(send).not.toHaveBeenCalled();
  });

  it("two alerts and no handle: never picks one", async () => {
    await mint("thread-1");
    await mint("thread-2");
    expect(await nudgeReply(db as never, { staffPhoneE164: STAFF, body: "Yes that works" }, T0)).toEqual({ handled: false });
  });

  it("leaves instructions, questions and long texts to the manager agent", async () => {
    await mint();
    expect(await nudgeReply(db as never, { staffPhoneE164: STAFF, body: "remind everyone about trash day" }, T0)).toEqual({ handled: false });
    expect(await nudgeReply(db as never, { staffPhoneE164: STAFF, body: "is rent paid at 5259?" }, T0)).toEqual({ handled: false });
    expect(await nudgeReply(db as never, { staffPhoneE164: STAFF, body: "x".repeat(120) }, T0)).toEqual({ handled: false });
  });

  it("an alert older than 30 minutes is not offered", async () => {
    await mint("thread-1", STAFF, "ws-1", new Date(T0.getTime() - 40 * 60_000));
    db.tables.sms_reply_handles![0]!.created_at = new Date(T0.getTime() - 40 * 60_000).toISOString();
    expect(await nudgeReply(db as never, { staffPhoneE164: STAFF, body: "Yes works" }, T0)).toEqual({ handled: false });
  });
});
