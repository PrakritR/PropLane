import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  rows: [] as Array<{ body: string }>,
  sendShared: vi.fn(),
  sendWork: vi.fn(),
  config: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/one-number/send.server", () => ({ sendSharedLineMessage: m.sendShared }));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: m.sendWork }));
vi.mock("@/lib/one-number/config.server", () => ({ loadSharedLineConfig: m.config, workspaceOnSharedLine: () => true }));
vi.mock("@/lib/one-number/inbound-alert.server", () => ({ alertOpsOfInboundText: m.alert }));

import { alertOpsOfCall, sendCallFollowUpLinks } from "@/lib/voice/voice-call-links.server";

const TOUR = "https://proplane.ai/rent/tours-contact?propertyId=mgr-listing-1x3tiu0489ha";
const LISTING = "https://proplane.ai/rent/listings/mgr-listing-1x3tiu0489ha";
const db = {
  from: () => {
    const chain: Record<string, unknown> = {};
    for (const k of ["select", "eq", "like"]) chain[k] = () => chain;
    chain.order = async () => ({ data: m.rows, error: null });
    return chain;
  },
} as never;
const resolved = (over: Record<string, unknown> = {}) =>
  ({ ok: true, managerId: "owner", workspaceId: "ws", workNumber: "+12066781909", line: "shared", route: { kind: "prospect" }, billing: { primary: { ownerId: "owner", workspaceId: "ws" }, platform: null }, ...over }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.rows = [{ body: `Links to text the caller after the call:\nPick a tour time: ${TOUR}\nListing: ${LISTING}` }];
  m.config.mockResolvedValue({ mode: "shared", sharedNumber: "+12066781909", pilotWorkspaceIds: [], dedicatedWorkspaceIds: [] });
  m.sendShared.mockResolvedValue({ ok: true, messageSid: "SM1", segments: 2 });
  m.sendWork.mockResolvedValue({ ok: true });
});

describe("the text after the call", () => {
  it("texts a prospect the pages the call offered, from the shared line, once per call", async () => {
    const out = await sendCallFollowUpLinks(db, { resolved: resolved(), fromPhone: "+13105550999", callSid: "CA1" });
    expect(out).toEqual({ sent: true });
    const call = m.sendShared.mock.calls[0]![1];
    expect(call).toMatchObject({ workspaceId: "ws", ownerUserId: "owner", toPhone: "+13105550999", role: "prospect", idempotencyKey: "voice-links:CA1" });
    expect(call.body).toContain(TOUR);
    expect(call.body).toContain(LISTING);
    expect(call.body).not.toMatch(/\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/);
  });

  it("a workspace's own work number sends from that number through the normal transport", async () => {
    const out = await sendCallFollowUpLinks(db, { resolved: resolved({ line: "dedicated", workNumber: "+12065559000" }), fromPhone: "+13105550999", callSid: "CA2" });
    expect(out).toEqual({ sent: true });
    expect(m.sendShared).not.toHaveBeenCalled();
    expect(m.sendWork).toHaveBeenCalledWith(expect.objectContaining({ managerUserId: "owner", to: "+13105550999", fromNumber: "+12065559000", dedupeKey: "voice-links:CA2", counterpartyRole: "prospect" }));
  });

  it("reports a refused send (opt-out, budget) instead of pretending", async () => {
    m.sendShared.mockResolvedValue({ ok: false, reason: "opted_out" });
    expect(await sendCallFollowUpLinks(db, { resolved: resolved(), fromPhone: "+13105550999", callSid: "CA3" })).toEqual({ sent: false, reason: "opted_out" });
  });

  it("sends nothing when no page was offered, and nothing to a resident or a manager", async () => {
    m.rows = [];
    expect(await sendCallFollowUpLinks(db, { resolved: resolved(), fromPhone: "+13105550999", callSid: "CA4" })).toEqual({ sent: false, reason: "nothing_offered" });
    expect(await sendCallFollowUpLinks(db, { resolved: resolved({ route: { kind: "resident" } }), fromPhone: "+13105550999", callSid: "CA5" })).toEqual({ sent: false, reason: "not_a_prospect" });
    expect(m.sendShared).not.toHaveBeenCalled();
  });

  it("ignores a link in the thread that is not one of our own pages", async () => {
    m.rows = [{ body: "Listing: https://evil.example/rent/listings/x\nPick a tour time: https://localhost:3000/rent/tours-contact?propertyId=x" }];
    expect(await sendCallFollowUpLinks(db, { resolved: resolved(), fromPhone: "+13105550999", callSid: "CA6" })).toEqual({ sent: false, reason: "nothing_offered" });
  });
});

describe("the alert about the call", () => {
  it("is the same one-line alert an inbound text raises, idempotent on the call", async () => {
    m.alert.mockResolvedValue("sent");
    const out = await alertOpsOfCall(db, { resolved: resolved(), fromPhone: "+13105550999", callSid: "CA7", gist: "Phone call: can I tour" });
    expect(out).toBe("sent");
    expect(m.alert).toHaveBeenCalledWith(db, expect.objectContaining({ messageSid: "voice:CA7", onPropLaneLine: true, workspaceId: "ws", body: "Phone call: can I tour" }));
  });

  it("never throws", async () => {
    m.alert.mockRejectedValue(new Error("down"));
    expect(await alertOpsOfCall(db, { resolved: resolved(), fromPhone: "+13105550999", callSid: "CA8", gist: "x" })).toBe("skipped");
  });
});
