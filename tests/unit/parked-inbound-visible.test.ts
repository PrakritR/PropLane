import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/** The configured shared PropLane line. Any other destination (a vendor's or a resident's own number) is not it. */
const SHARED_LINE = "+12066781909";

const session = vi.fn();
const recordInbound = vi.fn();
const notify = vi.fn();
const merge = vi.fn();
vi.mock("@/lib/one-number/session.server", () => ({ loadSharedLineSession: (...a: unknown[]) => session(...a) }));
vi.mock("@/lib/one-number/shared-line-number.server", () => ({
  isConfiguredSharedNumber: async (_db: unknown, phone: string) => phone === SHARED_LINE,
}));
vi.mock("@/lib/prospect-spine/record.server", () => ({ recordInbound: (...a: unknown[]) => recordInbound(...a) }));
vi.mock("@/lib/prospect-spine/context.server", () => ({ resolveInboundContext: async () => ({ propertyId: null, source: "sms" }) }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: (...a: unknown[]) => notify(...a) }));
vi.mock("@/lib/service/service-alert-targets.server", () => ({ serviceAlertPayerUserId: async () => "service-owner" }));
vi.mock("@/lib/prospect-spine/thread.server", () => ({
  readThread: async (_db: unknown, id: string) => ({ ownerUserId: "owner-1", rowData: {}, id }),
  mergeThreadRowData: (...a: unknown[]) => merge(...a),
}));

import { PARKED_INBOUND_REASON, reportEnvelopeIssue } from "@/lib/prospect-spine/delivery-issue.server";

type Rows = Record<string, unknown[]>;
/** A read-only fake: every chain on a table resolves to that table's rows (filters are not evaluated). */
function fakeDb(rows: Rows) {
  return {
    from(table: string) {
      const data = rows[table] ?? [];
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "limit", "order"]) chain[m] = () => chain;
      chain.maybeSingle = async () => ({ data: data[0] ?? null, error: null });
      chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(res);
      return chain;
    },
  } as never;
}

const envelope = {
  wire_from: "+15103098345",
  wire_to: SHARED_LINE,
  message_sid: "SM13a6f1a86e1065a7b61e902de1bb2a95",
  received_at: "2026-11-16T16:45:35.858Z",
  params: { Body: "Is room 8 open?" },
  status: "needs_review",
};

beforeEach(() => {
  session.mockReset();
  recordInbound.mockReset();
  notify.mockReset();
  merge.mockReset().mockResolvedValue(true);
});

describe("a parked inbound text is never invisible", () => {
  it("lands in the person's thread on the shared line, marked Not answered yet, and the owner's notice quotes it", async () => {
    session.mockResolvedValue({ currentWorkspaceId: "ws-1", activeRole: "prospect", pendingCandidates: null });
    recordInbound.mockResolvedValue({ ok: true, threadId: "thread-1", messageId: "m1", contextId: "c", created: false, duplicate: false, label: "" });
    const db = fakeDb({ sms_ingress_envelopes: [envelope], manager_sms_numbers: [], portal_workspaces: [{ owner_user_id: "owner-1" }] });
    await reportEnvelopeIssue(db, "env-1", "uncertain_effect");

    expect(recordInbound).toHaveBeenCalledTimes(1);
    const input = recordInbound.mock.calls[0]![1];
    // The carrier's id is the event key, the same one the normal path writes, so a text that already landed is not doubled.
    expect(input).toMatchObject({ workspaceId: "ws-1", ownerUserId: "owner-1", eventId: envelope.message_sid, body: "Is room 8 open?", channel: "sms", notify: false });
    expect(merge).toHaveBeenCalledWith(db, expect.objectContaining({ threadId: "thread-1", patch: expect.objectContaining({ deliveryIssue: expect.objectContaining({ reason: PARKED_INBOUND_REASON, direction: "inbound" }) }) }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![1]).toMatchObject({ landlordId: "owner-1", subject: "A text needs a reply" });
    expect(notify.mock.calls[0]![1].text).toContain('"Is room 8 open?"');
    expect(notify.mock.calls[0]![1].text).toContain("···8345");
    expect(notify.mock.calls[0]![1].text).not.toContain("5103098345");
  });

  it("never guesses a thread: an open which-home question or a non-prospect role goes to staff with the text quoted", async () => {
    for (const s of [
      { currentWorkspaceId: "ws-1", activeRole: "prospect", pendingCandidates: [{ workspaceId: "ws-2" }] },
      { currentWorkspaceId: "ws-1", activeRole: "resident", pendingCandidates: null },
      null,
    ]) {
      session.mockResolvedValue(s);
      notify.mockReset();
      recordInbound.mockReset();
      await reportEnvelopeIssue(fakeDb({ sms_ingress_envelopes: [envelope], manager_sms_numbers: [], portal_workspaces: [{ owner_user_id: "owner-1" }] }), "env-1", "uncertain_effect");
      expect(recordInbound).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0]![1]).toMatchObject({ landlordId: "service-owner", subject: "A text did not reach the inbox" });
      expect(notify.mock.calls[0]![1].text).toContain('"Is room 8 open?"');
    }
  });

  it("a workspace's own number needs an existing prospect conversation there before the text is written", async () => {
    recordInbound.mockResolvedValue({ ok: true, threadId: "thread-9", messageId: "m", contextId: "c", created: false, duplicate: true, label: "" });
    const dedicated = { manager_sms_numbers: [{ workspace_id: "ws-own", provision_state: "active" }], portal_workspaces: [{ owner_user_id: "owner-1" }] };
    await reportEnvelopeIssue(fakeDb({ sms_ingress_envelopes: [{ ...envelope, wire_to: "+12065550100" }], ...dedicated, sms_projection_conversations: [] }), "env-2", "uncertain_effect");
    expect(recordInbound).not.toHaveBeenCalled();

    await reportEnvelopeIssue(fakeDb({ sms_ingress_envelopes: [{ ...envelope, wire_to: "+12065550100" }], ...dedicated, sms_projection_conversations: [{ id: "c1" }] }), "env-2", "uncertain_effect");
    expect(recordInbound).toHaveBeenCalledTimes(1);
    expect(recordInbound.mock.calls[0]![1]).toMatchObject({ workspaceId: "ws-own" });
    expect(session).not.toHaveBeenCalled();
  });

  it("a number that is neither a workspace's own nor the shared line is never resolved from the sender's session", async () => {
    // The same webhook receives a vendor's / a resident's own PropLane Number, and the session is keyed on the phone
    // alone: without this gate a text to one of those numbers would land in a manager workspace's prospect thread.
    session.mockResolvedValue({ currentWorkspaceId: "ws-1", activeRole: "prospect", pendingCandidates: null });
    const db = fakeDb({
      sms_ingress_envelopes: [{ ...envelope, wire_to: "+12065559999" }],
      manager_sms_numbers: [],
      portal_workspaces: [{ owner_user_id: "owner-1" }],
    });
    await reportEnvelopeIssue(db, "env-4", "uncertain_effect");
    expect(recordInbound).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![1]).toMatchObject({ landlordId: "service-owner", subject: "A text did not reach the inbox" });
  });

  it("a thread write that fails still quotes the text to staff instead of a bare \"Not answered yet\"", async () => {
    session.mockResolvedValue({ currentWorkspaceId: "ws-1", activeRole: "prospect", pendingCandidates: null });
    recordInbound.mockResolvedValue({ ok: true, threadId: "thread-1", messageId: "m1", contextId: "c", created: false, duplicate: false, label: "" });
    merge.mockResolvedValue(false);
    const db = fakeDb({ sms_ingress_envelopes: [envelope], manager_sms_numbers: [], portal_workspaces: [{ owner_user_id: "owner-1" }] });
    await reportEnvelopeIssue(db, "env-5", "uncertain_effect");
    const staff = notify.mock.calls.find((c) => c[1].landlordId === "service-owner");
    expect(staff, "the degraded path must still raise the Attention item").toBeTruthy();
    expect(staff![1].text).toContain('"Is room 8 open?"');
    expect(staff![1].text).not.toBe(PARKED_INBOUND_REASON);
  });

  it("a reply-side reason keeps its own line and writes nothing into a thread", async () => {
    await reportEnvelopeIssue(fakeDb({ sms_ingress_envelopes: [envelope] }), "env-3", "delivery_unknown");
    expect(recordInbound).not.toHaveBeenCalled();
    expect(notify.mock.calls[0]![1].text).toBe("A reply to a text may not have been delivered: the carrier did not confirm it.");
  });
});
