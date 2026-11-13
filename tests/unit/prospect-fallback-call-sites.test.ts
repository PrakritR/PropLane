import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/service/service-alert-targets.server", () => ({
  isManagedWorkspaceId: async () => true,
  serviceAlertPayerUserId: async () => "svc-owner",
}));
const platformSend = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, sid: "SM1" }));
vi.mock("@/lib/one-number/lead-send.server", () => ({ sendPlatformLeadText: (...a: unknown[]) => platformSend(...a) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }) }));

const houseLine = vi.fn(async (..._a: unknown[]) => ({ ok: true, fromNumber: "+12065550100", selectedWorkLineId: "l1" }) as unknown);
vi.mock("@/lib/house-message-send.server", () => ({ resolveHouseSmsLine: (...a: unknown[]) => houseLine(...a) }));
const workSend = vi.fn(async (..._a: unknown[]) => ({ ok: false, error: "x" }) as { ok: boolean; error?: string; durablyAccepted?: boolean });
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: (...a: unknown[]) => workSend(...a) }));
const anyExport = vi.hoisted(() => () => new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : () => undefined) }));
vi.mock("@/lib/agent-notify.server", anyExport);
vi.mock("@/lib/agent/manager-email-agent.server", anyExport);
vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", anyExport);
vi.mock("@/lib/portal-inbox-delivery", anyExport);
vi.mock("@/lib/portal-inbox-storage", anyExport);
vi.mock("@/lib/prospect-spine/index.server", anyExport);
vi.mock("@/lib/stay-messages/facts.server", anyExport);
vi.mock("@/lib/stay-messages/sweep.server", anyExport);

import { relayReply, defaultRelayDeps, type RelayDeps } from "@/lib/manager-sms-commands/reply-relay.server";
import { createStayMessageSender } from "@/lib/stay-messages/send.server";
import { makeCommandDb } from "../helpers/command-fake-db";

beforeEach(() => {
  platformSend.mockClear();
  workSend.mockReset();
  houseLine.mockClear();
  houseLine.mockResolvedValue({ ok: true, fromNumber: "+12065550100", selectedWorkLineId: "l1" });
});

describe("stay messages: PropLane fallback only on a wallet/line refusal", () => {
  const stayInput = () =>
    ({
      candidate: { guestPhone: "+12065550188", workspaceId: "ws", ownerUserId: "client", propertyId: "p", guestUserId: null, guestEmail: null },
      property: { propertyId: "p" },
      smsBody: "hello",
      dedupeBase: "d1",
      already: { email: { status: "sent" }, inbox: { status: "sent" } },
    }) as never;

  it.each(["No conversation edit access.", "recipient_opted_out", "quiet_hours", "delivery_outcome_unknown", "communication_blocked"])(
    "refusal %s never reaches sendPlatformLeadText",
    async (error) => {
      workSend.mockResolvedValue({ ok: false, error });
      const out = await createStayMessageSender({} as never)(stayInput());
      expect(out.sms?.status).toBe("failed");
      expect(platformSend).not.toHaveBeenCalled();
    },
  );
  it("a credit refusal on a managed workspace is sent by PropLane", async () => {
    workSend.mockResolvedValue({ ok: false, error: "comms_billing_insufficient" });
    expect((await createStayMessageSender({} as never)(stayInput())).sms?.status).toBe("sent");
    expect(platformSend).toHaveBeenCalledTimes(1);
  });
  it("a house with no usable line is sent by PropLane", async () => {
    houseLine.mockResolvedValue({ ok: false });
    expect((await createStayMessageSender({} as never)(stayInput())).sms?.status).toBe("sent");
    expect(platformSend).toHaveBeenCalledTimes(1);
  });
});

describe("manager relay: PropLane fallback only on a wallet/line refusal code", () => {
  const STAFF = "+12065550142";
  const db = () =>
    makeCommandDb(
      {
        sms_phone_contacts: [{ phone_key: "2065550999", display_name: "Maya" }],
        portal_inbox_thread_records: [{ id: "thread-1", workspace_id: "ws-1", row_data: {} }],
      },
      { unique: { sms_reply_handles: ["staff_phone_key", "handle"] } },
    );
  async function run(sendBody: Record<string, unknown>, status: number) {
    const { mintReplyHandleFor } = await import("@/lib/manager-sms-commands/reply-relay.server");
    const d = db();
    const now = new Date();
    const handle = (await mintReplyHandleFor(d as never, { staffPhoneE164: STAFF, workspaceId: "ws-1", threadId: "thread-1", counterpartyPhoneE164: "+12065550999" }, now))!;
    const deps: RelayDeps = {
      buildContext: async () => ({ landlordId: "owner-1", userId: "staff-1", email: "s@example.test" }) as never,
      send: (async () => ({ body: sendBody, status })) as never,
      recordOutbound: (async () => undefined) as never,
      editOwnerIds: async () => ["owner-1"],
      now: () => now,
      propLaneFallback: defaultRelayDeps.propLaneFallback,
    };
    return relayReply(d as never, { staffPhoneE164: STAFF, actorUserId: "staff-1", workspaceIds: ["ws-1"], body: `${handle} hi there`, messageSid: "SM1" }, deps);
  }

  it("a 403 authorization refusal never reaches sendPlatformLeadText", async () => {
    const r = await run({ error: "No conversation edit access." }, 403);
    expect(r).toMatchObject({ handled: true });
    if (r.handled) expect(r.reply).toContain("Not sent");
    expect(platformSend).not.toHaveBeenCalled();
  });
  it.each(["recipient_opted_out", "communication_not_allowed", "delivery_outcome_unknown", "scoped_consent_missing"])("code %s never falls back", async (code) => {
    await run({ error: "nope", code }, 409);
    expect(platformSend).not.toHaveBeenCalled();
  });
  it("a credit code on a managed workspace falls back to PropLane", async () => {
    const r = await run({ error: "no credit", code: "comms_billing_insufficient" }, 503);
    expect(platformSend).toHaveBeenCalledTimes(1);
    if (r.handled) expect(r.reply).not.toContain("Not sent");
  });
});
