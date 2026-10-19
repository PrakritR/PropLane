// Taking your own PropLane Number carries the chat you had with the PropLane line onto it: agent session + messages
// and the inbox thread. Idempotent, and the PropLane-line copy is left alone.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type Row } from "../helpers/fake-table-db";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ delivered: new Map<string, Record<string, unknown>>(), calls: 0 }));
vi.mock("@/lib/service/service-catalog.server", () => ({ readPlatformServiceOwnerId: vi.fn(async () => "svc-owner") }));
vi.mock("@/lib/one-number/config.server", () => ({ loadSharedLineConfig: vi.fn(async () => ({ mode: "per_workspace", sharedNumber: null })) }));
vi.mock("@/lib/portal-inbox-delivery", () => ({
  scopeForRole: (role: string) => `scope:${role}`,
  deliverPortalMessageThreadSide: vi.fn(async (_db: unknown, args: Record<string, unknown>) => {
    m.calls += 1;
    const id = String(args.messageId);
    if (m.delivered.has(id)) return { action: "skipped", threadId: "t1" };
    m.delivered.set(id, args);
    return { action: m.delivered.size === 1 ? "create" : "append", threadId: "t1" };
  }),
}));

import { carryOverPropLaneLineHistory, copyPropLaneLineHistory } from "@/lib/one-number/vendor-jobs/history-transfer.server";

const PHONE = "+12065550142";
let fake: ReturnType<typeof createFakeDb>;
const db = () => fake as never;

function seed(extra: Record<string, Row[]> = {}) {
  fake = createFakeDb({
    agent_sessions: [
      { id: "s-vendor", landlord_id: "svc-owner", kind: "vendor_line_sms", vendor_phone_e164: PHONE },
      { id: "s-other", landlord_id: "svc-owner", kind: "vendor_line_sms", vendor_phone_e164: "+12065559999" },
      { id: "s-lease", landlord_id: "svc-owner", kind: "leasing_sms", vendor_phone_e164: PHONE },
    ],
    agent_messages: [
      { id: "am1", session_id: "s-vendor", landlord_id: "svc-owner", role: "user", content: "any jobs available", channel: "sms", created_at: "2026-10-19T10:00:00Z", tool_trace: { sid: "SM1" } },
      { id: "am2", session_id: "s-vendor", landlord_id: "svc-owner", role: "assistant", content: "Open jobs: 1. Plumbing", channel: "sms", created_at: "2026-10-19T10:00:01Z", tool_trace: { sid: "SM1:reply" } },
      { id: "am3", session_id: "s-other", landlord_id: "svc-owner", role: "user", content: "someone else", channel: "sms", created_at: "2026-10-19T10:00:02Z" },
      { id: "am4", session_id: "s-lease", landlord_id: "svc-owner", role: "user", content: "is room 3 available", channel: "sms", created_at: "2026-10-19T10:00:03Z" },
    ],
    manager_sms_messages: [
      { id: "mm1", manager_user_id: "svc-owner", resident_phone: PHONE, direction: "inbound", body: "any jobs available", counterparty_role: "vendor", created_at: "2026-10-19T10:00:00Z" },
      { id: "mm2", manager_user_id: "svc-owner", resident_phone: PHONE, direction: "outbound", body: "Open jobs: 1. Plumbing", counterparty_role: "vendor", created_at: "2026-10-19T10:00:01Z" },
      { id: "mm3", manager_user_id: "svc-owner", resident_phone: PHONE, direction: "inbound", body: "is room 3 available", counterparty_role: "prospect", created_at: "2026-10-19T10:00:03Z" },
      { id: "mm4", manager_user_id: "svc-owner", resident_phone: "+12065559999", direction: "inbound", body: "someone else", counterparty_role: "vendor", created_at: "2026-10-19T10:00:04Z" },
    ],
    manager_sms_numbers: [{ manager_user_id: "svc-owner", phone_number: "+12065551909", released_at: null }],
    profiles: [{ id: "vendor-7", phone: PHONE, phone_verified_at: "2026-09-01T00:00:00Z" }],
    ...extra,
  });
}

beforeEach(() => {
  m.delivered.clear();
  m.calls = 0;
  seed();
});

describe("copyPropLaneLineHistory", () => {
  it("copies a vendor's agent session and inbox thread onto the new owner", async () => {
    const out = await copyPropLaneLineHistory(db(), { phoneE164: PHONE, role: "vendor", newOwnerId: "vendor-7" });
    expect(out).toMatchObject({ ok: true, agentMessagesCopied: 2, inboxMessagesCopied: 2 });
    const session = fake.tables.agent_sessions!.find((s) => s.kind === "propline_carryover")!;
    expect(session).toMatchObject({ landlord_id: "vendor-7", vendor_phone_e164: PHONE });
    const copied = fake.tables.agent_messages!.filter((r) => r.session_id === session.id);
    expect(copied.map((r) => [r.role, r.content])).toEqual([["user", "any jobs available"], ["assistant", "Open jobs: 1. Plumbing"]]);
    expect(copied.every((r) => r.landlord_id === "vendor-7")).toBe(true);
    const threads = [...m.delivered.values()];
    expect(threads).toHaveLength(2);
    expect(threads[0]).toMatchObject({ scope: "scope:vendor", ownerUserId: "vendor-7", outbound: false, unread: false, messageId: "propline-copy:vendor-7:mm1" });
    expect(threads[1]).toMatchObject({ outbound: true, messageId: "propline-copy:vendor-7:mm2" });
    expect((threads[0]!.conversation as Record<string, unknown>).otherPartyPhone).toBe("+12065551909");
  });

  it("is idempotent: a second run, or a second activation, adds nothing", async () => {
    await copyPropLaneLineHistory(db(), { phoneE164: PHONE, role: "vendor", newOwnerId: "vendor-7" });
    const before = fake.tables.agent_messages!.length;
    const again = await copyPropLaneLineHistory(db(), { phoneE164: PHONE, role: "vendor", newOwnerId: "vendor-7" });
    expect(again).toMatchObject({ ok: true, agentMessagesCopied: 0, inboxMessagesCopied: 0 });
    expect(fake.tables.agent_messages).toHaveLength(before);
    expect(fake.tables.agent_sessions!.filter((s) => s.kind === "propline_carryover")).toHaveLength(1);
  });

  it("leaves the PropLane-line copy exactly as it was", async () => {
    const snapshot = JSON.stringify([fake.tables.agent_sessions!.filter((s) => s.kind !== "propline_carryover"), fake.tables.manager_sms_messages]);
    await copyPropLaneLineHistory(db(), { phoneE164: PHONE, role: "vendor", newOwnerId: "vendor-7" });
    expect(JSON.stringify([fake.tables.agent_sessions!.filter((s) => s.kind !== "propline_carryover"), fake.tables.manager_sms_messages])).toBe(snapshot);
    expect(fake.tables.agent_messages!.filter((r) => r.landlord_id === "svc-owner")).toHaveLength(4);
  });

  it("a resident takes the leasing chat and the prospect thread, not the vendor one", async () => {
    const out = await copyPropLaneLineHistory(db(), { phoneE164: PHONE, role: "resident", newOwnerId: "res-1", newWorkspaceId: "ws-9" });
    expect(out).toMatchObject({ ok: true, agentMessagesCopied: 1, inboxMessagesCopied: 1 });
    const threads = [...m.delivered.values()];
    expect(threads[0]).toMatchObject({ scope: "scope:resident", body: "is room 3 available" });
    expect((threads[0]!.conversation as Record<string, unknown>).workspaceId).toBe("ws-9");
  });

  it("someone who never texted the line gets nothing", async () => {
    const out = await copyPropLaneLineHistory(db(), { phoneE164: "+12065558888", role: "vendor", newOwnerId: "vendor-8" });
    expect(out).toMatchObject({ ok: true, agentMessagesCopied: 0, inboxMessagesCopied: 0 });
    expect(fake.tables.agent_sessions!.some((s) => s.kind === "propline_carryover")).toBe(false);
  });

  it("refuses a bad phone and never copies a chat onto its own owner", async () => {
    expect(await copyPropLaneLineHistory(db(), { phoneE164: "nope", role: "vendor", newOwnerId: "vendor-7" })).toMatchObject({ ok: false, reason: "invalid_phone" });
    expect(await copyPropLaneLineHistory(db(), { phoneE164: PHONE, role: "vendor", newOwnerId: "svc-owner" })).toMatchObject({ reason: "same_owner" });
  });

  it("another person's chat is never copied (the phone scopes it)", async () => {
    await copyPropLaneLineHistory(db(), { phoneE164: PHONE, role: "vendor", newOwnerId: "vendor-7" });
    expect(JSON.stringify([...m.delivered.values()])).not.toContain("someone else");
    expect(JSON.stringify(fake.tables.agent_messages!.filter((r) => r.landlord_id === "vendor-7"))).not.toContain("someone else");
  });
});

describe("carryOverPropLaneLineHistory (the activation hook)", () => {
  it("reads the verified phone from the profile, never from the caller", async () => {
    const out = await carryOverPropLaneLineHistory(db(), "vendor-7", "vendor");
    expect(out).toMatchObject({ ok: true, agentMessagesCopied: 2, inboxMessagesCopied: 2 });
  });

  it("an unverified phone copies nothing", async () => {
    seed({ profiles: [{ id: "vendor-7", phone: PHONE, phone_verified_at: null }] });
    const out = await carryOverPropLaneLineHistory(db(), "vendor-7", "vendor");
    expect(out.agentMessagesCopied + out.inboxMessagesCopied).toBe(0);
    expect(m.calls).toBe(0);
  });

  it("never throws into an activation", async () => {
    const broken = { from: () => { throw new Error("db down"); } } as never;
    await expect(carryOverPropLaneLineHistory(broken, "vendor-7", "vendor")).resolves.toMatchObject({ ok: false });
  });
});
