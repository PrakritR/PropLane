// Web chat orchestration over its ports: the home is re-derived, a message goes through the spine as channel in_app / source
// web_chat (a handle before proof, the phone after), the assistant runs only after a credit reservation that is handed back
// when nothing is produced, rate limits answer 429, only a PROVEN phone merges, and a visitor reads only their own thread.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent/leasing-web-agent.server", () => ({}));
vi.mock("@/lib/automation-send-mode.server", () => ({}));
vi.mock("@/lib/manager-assistant-email/email-auto-reply-credit.server", () => ({}));
vi.mock("@/lib/one-number/link-text.server", () => ({}));
vi.mock("@/lib/one-number/phone-otp.server", () => ({}));
vi.mock("@/lib/prospect-spine/record.server", () => ({}));
vi.mock("@/lib/prospect-spine/stitch.server", () => ({}));
vi.mock("@/lib/prospect-spine/thread.server", () => ({}));
vi.mock("@/lib/rate-limit", () => ({}));
vi.mock("@/lib/sms-consent", () => ({}));
vi.mock("@/lib/listing-message/listing.server", () => ({}));
vi.mock("@/lib/one-number/public-bind.server", () => ({ publicBindPhoneKey: (raw: string) => (String(raw).replace(/\D/g, "").slice(-10).length === 10 ? String(raw).replace(/\D/g, "").slice(-10) : null) }));

import type { RecordInboundInput, RecordOutboundInput } from "@/lib/prospect-spine/contracts";
import { pollWebChat, sendWebChatMessage, sendWebChatPhoneCode, verifyWebChatPhone, type SessionRow, type WebChatDeps } from "@/lib/web-chat/chat.server";

const LISTING = { propertyId: "prop_1", workspaceId: "ws_1", ownerUserId: "owner_1", propertyLabel: "5259 Brooklyn", roomId: "room_2", roomLabel: "Room 2" };

function makeDeps(over: Partial<{ limit: (key: string) => boolean; hold: boolean; reply: string | null; credit: boolean; verify: boolean; threadRows: Record<string, { ownerUserId: string; rowData: Record<string, unknown> }> }> = {}) {
  const sessions = new Map<string, SessionRow>();
  const calls = { inbound: [] as RecordInboundInput[], outbound: [] as RecordOutboundInput[], reserve: 0, finish: [] as boolean[], run: 0, stitch: [] as Array<{ workspaceId: string; visitorId: string; phoneE164: string }>, keys: [] as string[], verified: [] as string[] };
  const deps: WebChatDeps = {
    now: () => new Date("2026-11-15T17:00:00Z"),
    uuid: () => "uuid",
    loadListing: async (propertyId, roomId) => {
      if (propertyId !== "prop_1") return { ok: false, reason: "not_found" };
      if (roomId && roomId !== "room_2") return { ok: false, reason: "room_not_found" };
      return { ok: true, listing: { ...LISTING, roomId, roomLabel: roomId ? "Room 2" : null } };
    },
    rateLimit: async (key) => { calls.keys.push(key); return over.limit ? over.limit(key) : true; },
    sessions: {
      get: async (v, w) => sessions.get(`${v}:${w}`) ?? null,
      getForProperty: async (v, p) => [...sessions.values()].find((s) => s.visitorId === v && s.propertyId === p) ?? null,
      upsert: async (i) => {
        const key = `${i.visitorId}:${i.workspaceId}`;
        const row = sessions.get(key) ?? { id: `s_${sessions.size}`, visitorId: i.visitorId, workspaceId: i.workspaceId, propertyId: i.propertyId, roomId: i.roomId, threadId: null, phoneE164: null, phoneVerifiedAt: null };
        sessions.set(key, row);
        return row;
      },
      patch: async (id, patch) => { for (const s of sessions.values()) if (s.id === id) Object.assign(s, patch); },
    },
    recordInbound: async (input) => { calls.inbound.push(input); return { ok: true, threadId: input.identity.kind === "phone" ? "thread_phone" : "thread_web", messageId: `prospect_${input.eventId}`, contextId: "ctx", created: true, duplicate: false, label: "x" }; },
    recordOutbound: async (input) => { calls.outbound.push(input); return { ok: true }; },
    readThreadRow: async (id) => over.threadRows?.[id] ?? null,
    agent: {
      reserve: async () => { calls.reserve += 1; return over.credit === false ? { allowed: false, reason: "no_credit" } : { allowed: true, key: "k1" }; },
      finish: async ({ produced }) => { calls.finish.push(produced); },
      approvalHold: async () => over.hold === true,
      run: async () => { calls.run += 1; return over.reply === null ? null : { reply: over.reply ?? "The room is open." }; },
    },
    phone: {
      sendCode: async () => ({ ok: true }),
      verifyCode: async () => (over.verify === false ? { ok: false, reason: "wrong" } : { ok: true }),
      markVerified: async ({ phoneE164 }) => { calls.verified.push(phoneE164); },
      stitch: async (i) => { calls.stitch.push(i); return { ok: true, threadId: "thread_phone", movedContextIds: [] }; },
    },
  };
  return { deps, calls, sessions };
}

const send = (deps: WebChatDeps, over: Record<string, unknown> = {}) =>
  sendWebChatMessage(deps, { visitorId: "v1", ip: "1.1.1.1", propertyId: "prop_1", roomId: null, body: "Is it open?", clientMessageId: "client-1", ...over } as never);

describe("sendWebChatMessage", () => {
  it("records a web_chat handle turn as in_app, re-derives the home, and writes the assistant reply back to the thread", async () => {
    const { deps, calls } = makeDeps();
    const out = await send(deps);
    expect(out).toMatchObject({ ok: true, reply: "The room is open." });
    const input = calls.inbound[0];
    expect(input).toMatchObject({ workspaceId: "ws_1", ownerUserId: "owner_1", channel: "in_app", context: { source: "web_chat", propertyId: "prop_1" }, identity: { kind: "handle", contactHandle: "web_v1", site: "web_chat" } });
    expect(calls.outbound[0]).toMatchObject({ threadId: "thread_web", author: { kind: "assistant" }, channel: "in_app" });
    expect(calls.reserve).toBe(1);
    expect(calls.finish).toEqual([true]);
  });

  it("refuses an unknown listing or room and never names an owner from the body", async () => {
    const { deps } = makeDeps();
    expect(await send(deps, { propertyId: "nope" })).toMatchObject({ ok: false, status: 404 });
    expect(await send(deps, { roomId: "room_9" })).toMatchObject({ ok: false, status: 400 });
  });

  it("answers 429 per IP, per visitor and per property, before any write", async () => {
    for (const fragment of ["send-ip", "send-visitor-h", "send-visitor-d", "send-property"]) {
      const { deps, calls } = makeDeps({ limit: (key) => !key.includes(fragment) });
      expect(await send(deps)).toMatchObject({ ok: false, status: 429 });
      expect(calls.inbound).toHaveLength(0);
      expect(calls.run).toBe(0);
    }
  });

  it("reserves credit BEFORE the model and hands it back when nothing was produced", async () => {
    const empty = makeDeps({ reply: null });
    expect(await send(empty.deps)).toMatchObject({ ok: true });
    expect(empty.calls.finish).toEqual([false]);
    const broke = makeDeps({ credit: false });
    const out = await send(broke.deps);
    expect(out).toMatchObject({ ok: true });
    expect("reply" in out).toBe(false);
    expect(broke.calls.run).toBe(0);
    expect(broke.calls.inbound).toHaveLength(1);
  });

  it("holds the assistant when the manager's approval setting says so (the team answers) but still stores the message", async () => {
    const { deps, calls } = makeDeps({ hold: true });
    const out = await send(deps);
    expect(out).toMatchObject({ ok: true });
    expect(calls.run).toBe(0);
    expect(calls.finish).toEqual([false]);
    expect(calls.inbound).toHaveLength(1);
  });

  it("offers the texted code for a typed phone but does NOT merge or verify it", async () => {
    const { deps, calls } = makeDeps();
    const out = await send(deps, { body: "text me at (206) 555-0142" });
    expect(out).toMatchObject({ ok: true, phoneOffer: "2065550142" });
    expect(calls.stitch).toHaveLength(0);
    expect(calls.verified).toHaveLength(0);
    expect(calls.inbound[0].identity.kind).toBe("handle");
  });

  it("an idempotent replay stores nothing twice and runs no second model turn", async () => {
    const { deps, calls } = makeDeps();
    deps.recordInbound = async (input) => ({ ok: true, threadId: "t", messageId: `prospect_${input.eventId}`, contextId: "c", created: false, duplicate: true, label: "x" });
    expect(await send(deps)).toMatchObject({ ok: true, duplicate: true });
    expect(calls.reserve).toBe(0);
  });
});

describe("continuing by text", () => {
  it("merges ONLY after the code is proven, then writes as that phone", async () => {
    const { deps, calls, sessions } = makeDeps();
    await send(deps);
    const wrong = makeDeps({ verify: false });
    await send(wrong.deps);
    expect(await verifyWebChatPhone(wrong.deps, { visitorId: "v1", ip: "1.1.1.1", propertyId: "prop_1", phone: "2065550142", otp: "000000" })).toMatchObject({ ok: false, status: 400 });
    expect(wrong.calls.stitch).toHaveLength(0);
    expect(wrong.calls.verified).toHaveLength(0);

    const ok = await verifyWebChatPhone(deps, { visitorId: "v1", ip: "1.1.1.1", propertyId: "prop_1", phone: "(206) 555-0142", otp: "123456" });
    expect(ok).toMatchObject({ ok: true, merged: true });
    expect(calls.stitch).toEqual([{ workspaceId: "ws_1", visitorId: "v1", phoneE164: "+12065550142" }]);
    expect([...sessions.values()][0]).toMatchObject({ phoneE164: "+12065550142", threadId: "thread_phone" });

    await send(deps, { clientMessageId: "client-2", body: "one more question" });
    expect(calls.inbound.at(-1).identity).toMatchObject({ kind: "phone", phoneE164: "+12065550142", verified: true });
  });

  it("needs a prior message, rate limits codes, and the code subject is bound to the visitor", async () => {
    const { deps } = makeDeps();
    expect(await verifyWebChatPhone(deps, { visitorId: "v1", ip: "1.1.1.1", propertyId: "prop_1", phone: "2065550142", otp: "123456" })).toMatchObject({ ok: false, status: 400 });
    const limited = makeDeps({ limit: () => false });
    expect(await sendWebChatPhoneCode(limited.deps, { visitorId: "v1", ip: "1.1.1.1", propertyId: "prop_1", phone: "2065550142" })).toMatchObject({ ok: false, status: 429 });
    const sendCode = vi.fn(async () => ({ ok: true as const }));
    deps.phone.sendCode = sendCode;
    await sendWebChatPhoneCode(deps, { visitorId: "v9", ip: "1.1.1.1", propertyId: "prop_1", phone: "2065550142" });
    expect(sendCode).toHaveBeenCalledWith(expect.objectContaining({ subjectId: "web_chat:v9", phoneKey: "2065550142" }));
  });
});

describe("pollWebChat", () => {
  const rowData = (text: string) => ({ rootMessageId: "m1", body: text, from: "Web visitor", messages: [{ id: "m2", from: "Dana", body: "Reply for you", senderUserId: "staff" }], ownerUserId: "secret" });
  it("returns only the thread bound to THIS visitor's session, and nothing for another visitor", async () => {
    const { deps } = makeDeps({ threadRows: { thread_web: { ownerUserId: "owner_1", rowData: rowData("mine") } } });
    await send(deps);
    const mine = await pollWebChat(deps, { visitorId: "v1", propertyId: "prop_1", afterId: null });
    expect(mine).toMatchObject({ ok: true });
    expect(mine.ok && mine.turns.map((t) => t.body)).toEqual(["mine", "Reply for you"]);
    expect(JSON.stringify(mine)).not.toMatch(/secret|Dana|staff/);
    const other = await pollWebChat(deps, { visitorId: "v2", propertyId: "prop_1", afterId: null });
    expect(other).toMatchObject({ ok: true, turns: [] });
  });
  it("honours the cursor and the per-visitor poll limit", async () => {
    const { deps } = makeDeps({ threadRows: { thread_web: { ownerUserId: "owner_1", rowData: rowData("mine") } } });
    await send(deps);
    const after = await pollWebChat(deps, { visitorId: "v1", propertyId: "prop_1", afterId: "m1" });
    expect(after.ok && after.turns.map((t) => t.id)).toEqual(["m2"]);
    const limited = makeDeps({ limit: (key) => !key.includes("poll") });
    expect(await pollWebChat(limited.deps, { visitorId: "v1", propertyId: "prop_1", afterId: null })).toMatchObject({ ok: false, status: 429 });
  });
});

describe("Assistant review pause", () => {
  it("a paused conversation records the visitor's message but runs no assistant turn and spends no credit", async () => {
    const { deps, calls } = makeDeps();
    const seen: Array<{ workspaceId: string; threadKeys: string[] }> = [];
    deps.agent.paused = async (input) => { seen.push(input); return true; };
    const out = await send(deps);
    expect(out).toMatchObject({ ok: true });
    expect((out as { reply?: string }).reply).toBeUndefined();
    expect(calls.inbound).toHaveLength(1);
    expect(calls.run).toBe(0);
    expect(calls.finish).toEqual([false]);
    expect(seen[0]!.threadKeys).toEqual(expect.arrayContaining(["thread_web"]));
  });
  it("an unreadable pause state holds the reply (fails closed)", async () => {
    const { deps, calls } = makeDeps();
    deps.agent.paused = async () => { throw new Error("db down"); };
    await send(deps);
    expect(calls.run).toBe(0);
  });
});
