import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AIRBNB_MESSAGE,
  BOOKING_MESSAGE,
  PADSPLIT_MESSAGE,
  type ChannelEmailFixture,
} from "../fixtures/channel-inbox-emails";

const mocks = vi.hoisted(() => ({
  runLeasingEmailAgentTurn: vi.fn(),
  deliverManagerEmailReply: vi.fn(),
  runManagerEmailAgentTurn: vi.fn(),
  mirrorAssistantEmailConversation: vi.fn(),
  mirrorAssistantEmailTurnToInbox: vi.fn(),
  notifyManagerFromAgent: vi.fn(),
  fanOutWorkspaceNotice: vi.fn(),
  fetchHeaders: vi.fn(),
  reserveCommsCredit: vi.fn(),
  finishCommsCredit: vi.fn(),
  commsTurnKey: vi.fn(),
  partyFacingAnswerHold: vi.fn(),
  loadManagerAssistantEmail: vi.fn(),
  resolveWorkspaceOwnerForWorkEmail: vi.fn(),
  loadServiceWorkspaceIds: vi.fn(),
  resolveListingTextNumbers: vi.fn(),
  classifyAssistantEmailSender: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/agent/leasing-email-agent.server", () => ({ runLeasingEmailAgentTurn: mocks.runLeasingEmailAgentTurn }));
vi.mock("@/lib/agent/manager-email-agent.server", () => ({
  runManagerEmailAgentTurn: mocks.runManagerEmailAgentTurn,
  deliverManagerEmailReply: mocks.deliverManagerEmailReply,
}));
vi.mock("@/lib/manager-assistant-email/mirror-assistant-email-conversation.server", () => ({
  mirrorAssistantEmailConversation: mocks.mirrorAssistantEmailConversation,
}));
vi.mock("@/lib/manager-assistant-email/mirror-assistant-email-to-inbox.server", () => ({
  mirrorAssistantEmailTurnToInbox: mocks.mirrorAssistantEmailTurnToInbox,
}));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: mocks.notifyManagerFromAgent }));
vi.mock("@/lib/workspace-team-fanout.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-team-fanout.server")>()),
  fanOutWorkspaceNotice: mocks.fanOutWorkspaceNotice,
}));
vi.mock("@/lib/comms-billing/wallet.server", () => ({ reserveCommsCredit: mocks.reserveCommsCredit, finishCommsCredit: mocks.finishCommsCredit }));
vi.mock("@/lib/comms-billing/turn-result.server", () => ({ commsTurnKey: mocks.commsTurnKey }));
vi.mock("@/lib/automation-send-mode.server", () => ({ partyFacingAnswerHold: mocks.partyFacingAnswerHold }));
vi.mock("@/lib/inbound-email/inbound-email-headers.server", () => ({ fetchResendReceivedEmailHeaders: mocks.fetchHeaders }));
vi.mock("@/lib/inbound-email/inbound-email.server", () => ({ resolveInboundEmailBody: vi.fn() }));
vi.mock("@/lib/sms/manager-workspace-role.server", () => ({ resolveWorkspaceOwnerForWorkEmail: mocks.resolveWorkspaceOwnerForWorkEmail }));
vi.mock("@/lib/service/service-catalog.server", () => ({ loadServiceWorkspaceIds: mocks.loadServiceWorkspaceIds }));
vi.mock("@/lib/listing-text-number.server", () => ({
  resolveListingTextNumbers: mocks.resolveListingTextNumbers,
  listingTextNumberKey: (t: { ownerUserId: string; workspaceId?: string | null }) => `${t.ownerUserId}:${t.workspaceId ?? ""}`,
}));
vi.mock("@/lib/manager-assistant-email/assistant-email-sender-role.server", () => ({ classifyAssistantEmailSender: mocks.classifyAssistantEmailSender }));
vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({
  resolveAssistantMailboxByInboundAddresses: async () => ({ managerUserId: "mgr-1", workspaceId: "ws-1" }),
  loadManagerAssistantEmail: mocks.loadManagerAssistantEmail,
}));
vi.mock("@/lib/tools/manager-sms-context", () => ({ resolveManagerSmsAgentContext: vi.fn() }));
vi.mock("@/lib/agent/inbox-auto-respond.server", () => ({ autoRespondToResidentInboxMessage: vi.fn() }));
vi.mock("@/lib/agent/resident-email-session.server", () => ({
  findOrCreateResidentEmailSession: vi.fn(), loadResidentEmailHistory: vi.fn(), recordResidentEmailInbound: vi.fn(), recordResidentEmailReply: vi.fn(),
}));

import { processManagerAssistantInboundEmail } from "@/lib/manager-assistant-email/process-assistant-inbound.server";
import { channelGuestKeyAddress } from "@/lib/inbound-email/channel-senders";

const MAILBOX = "assist-ambika@prop-lane.space";

const tables: Record<string, Record<string, unknown>[]> = {};
function makeDb() {
  const chain = (table: string) => {
    let rows = tables[table] ?? [];
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, value: unknown) => { rows = rows.filter((r) => r[col] === value); return q; },
      in: (col: string, values: unknown[]) => { rows = rows.filter((r) => values.includes(r[col])); return q; },
      insert: async () => ({ error: null }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
    };
    return q;
  };
  return { from: (table: string) => chain(table) } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

const SIGNED = (domain: string) => ({ "authentication-results": [`mx.resend.com; dkim=pass header.d=${domain}`] });

function inbound(fixture: ChannelEmailFixture, overrides: Record<string, unknown> = {}) {
  return {
    emailId: `email_${Math.random().toString(36).slice(2)}`,
    fromEmail: fixture.fromEmail,
    fromName: fixture.fromName,
    toEmails: [MAILBOX],
    subject: fixture.subject,
    receivedAt: "2026-10-27T18:00:00.000Z",
    text: fixture.text,
    ...(fixture.replyTo ? { replyTo: fixture.replyTo } : {}),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ASSISTANT_EMAIL_DOMAIN = "prop-lane.space";
  for (const key of Object.keys(tables)) delete tables[key];
  tables.external_calendar_connections = [
    { id: "c1", manager_user_id: "mgr-1", property_id: "p5257", room_id: "r6", provider: "airbnb", label: null, import_url: "https://www.airbnb.com/calendar/ical/1.ics", export_token: "t1", imported_ranges: [{ id: "i1", start: "2026-11-12", end: "2026-11-19", sourceUid: "u1", summary: "Reserved", reservationCode: "HMTESTCODE1" }] },
    { id: "c2", manager_user_id: "mgr-1", property_id: "p4709", room_id: "r9", provider: "booking_com", label: null, import_url: "https://ical.booking.com/v1/export?t=1", export_token: "t2", imported_ranges: [] },
    { id: "c3", manager_user_id: "mgr-1", property_id: "p5259", room_id: "r1", provider: "ical", label: "PadSplit", import_url: "https://example.com/padsplit.ics", export_token: "t3", imported_ranges: [] },
  ];
  tables.manager_property_records = [
    { id: "p5257", manager_user_id: "mgr-1", workspace_id: "ws-1", property_data: { address: "5257 Brooklyn Ave", listingSubmission: { v: 1, rooms: [{ id: "r6", name: "Room 6" }] } } },
    { id: "p4709", manager_user_id: "mgr-1", workspace_id: "ws-1", property_data: { address: "4709A 8th Ave", listingSubmission: { v: 1, rooms: [{ id: "r9", name: "Room 9" }] } } },
    { id: "p5259", manager_user_id: "mgr-1", workspace_id: "ws-1", property_data: { address: "5259 Brooklyn Ave", listingSubmission: { v: 1, rooms: [{ id: "r1", name: "Room 1" }] } } },
  ];
  mocks.resolveWorkspaceOwnerForWorkEmail.mockResolvedValue({ ownerUserId: "mgr-1", sharedFromCoManager: false, workspaceId: "ws-1" });
  mocks.loadManagerAssistantEmail.mockResolvedValue({ managerUserId: "mgr-1", address: MAILBOX, provisionState: "active" });
  mocks.fetchHeaders.mockResolvedValue(SIGNED("airbnb.com"));
  mocks.commsTurnKey.mockImplementation(async (_db: unknown, _owner: string, base: string) => base);
  mocks.reserveCommsCredit.mockResolvedValue({ allowed: true, duplicate: false, state: "reserved" });
  mocks.finishCommsCredit.mockResolvedValue(undefined);
  mocks.partyFacingAnswerHold.mockResolvedValue({ hold: false, reason: null });
  mocks.fanOutWorkspaceNotice.mockResolvedValue({ notified: 0 });
  mocks.notifyManagerFromAgent.mockResolvedValue({ delivered: true, suppressed: false });
  mocks.mirrorAssistantEmailConversation.mockResolvedValue(undefined);
  mocks.deliverManagerEmailReply.mockResolvedValue({ ok: true });
  mocks.loadServiceWorkspaceIds.mockResolvedValue([]);
  mocks.resolveListingTextNumbers.mockResolvedValue(new Map([["mgr-1:ws-1", "+12066781909"]]));
  mocks.runLeasingEmailAgentTurn.mockResolvedValue({
    reply: "Hi Jose! Early check-in is usually fine; we will confirm the exact time before you arrive.",
    sessionId: "s1",
    traceId: null,
    channel: { violations: [], availabilityReplaced: false },
  });
});

describe("a verified guest message lands in the right conversation and room", () => {
  it("Airbnb: one conversation per guest, tagged with the site and the matched room, answered to the relay address", async () => {
    const result = await processManagerAssistantInboundEmail(makeDb(), inbound(AIRBNB_MESSAGE));
    expect(result).toMatchObject({ handled: true, replied: true, role: "channel" });

    const mirror = mocks.mirrorAssistantEmailConversation.mock.calls[0]![1];
    expect(mirror.senderEmail).toBe(channelGuestKeyAddress("airbnb", "Jose Alaniz"));
    expect(mirror.propertyId).toBe("p5257");
    expect(mirror.channelGuest).toMatchObject({ site: "airbnb", propertyId: "p5257", roomId: "r6", roomLabel: "Room 6", replyAddress: "k3f9a1c2d4@reply.airbnb.com", held: false });
    expect(mirror.workspaceId).toBe("ws-1");
    expect(mirror.inboundText).toContain("early check-in");
    expect(mirror.replyAsReviewDraft).toBe(false);

    // The relay reply: from the work email, to the parsed relay address, flagged as an authenticated channel message.
    expect(mocks.deliverManagerEmailReply).toHaveBeenCalledTimes(1);
    expect(mocks.deliverManagerEmailReply.mock.calls[0]![0]).toMatchObject({
      toEmail: "k3f9a1c2d4@reply.airbnb.com",
      fromAddress: MAILBOX,
      channel: { site: "airbnb", authenticated: true },
    });
    // The leasing turn got the channel brief with the matched room.
    expect(mocks.runLeasingEmailAgentTurn.mock.calls[0]![1].channel).toMatchObject({ site: "airbnb", listingLine: "5257 Brooklyn Ave, Room 6", serviceWorkspace: false });
    // Credit was reserved before the model ran.
    expect(mocks.reserveCommsCredit.mock.invocationCallOrder[0]).toBeLessThan(mocks.runLeasingEmailAgentTurn.mock.invocationCallOrder[0]!);
  });

  it("the same guest writing again is the same conversation key", async () => {
    await processManagerAssistantInboundEmail(makeDb(), inbound(AIRBNB_MESSAGE));
    await processManagerAssistantInboundEmail(makeDb(), inbound(AIRBNB_MESSAGE, { subject: "New message from Jose Alaniz" }));
    const keys = mocks.mirrorAssistantEmailConversation.mock.calls.map((call) => call[1].senderEmail);
    expect(new Set(keys).size).toBe(1);
  });

  it("Booking.com: mapped to its room, answered through its relay", async () => {
    mocks.fetchHeaders.mockResolvedValue(SIGNED("booking.com"));
    const result = await processManagerAssistantInboundEmail(makeDb(), inbound(BOOKING_MESSAGE));
    expect(result).toMatchObject({ replied: true, role: "channel" });
    expect(mocks.mirrorAssistantEmailConversation.mock.calls[0]![1].channelGuest).toMatchObject({ site: "booking_com", propertyId: "p4709", roomId: "r9" });
    expect(mocks.deliverManagerEmailReply.mock.calls[0]![0].toEmail).toBe("mt-8d41f0@guest.booking.com");
  });

  it("a forwarded copy (Gmail auto-forward) keeps the site's signature and is answered the same way", async () => {
    // The From stays airbnb.com; only the envelope changed. Resend still reports the original DKIM pass.
    mocks.fetchHeaders.mockResolvedValue({ "authentication-results": ["mx.resend.com; dkim=pass header.d=airbnb.com; spf=softfail smtp.mailfrom=gmail.com"] });
    const result = await processManagerAssistantInboundEmail(makeDb(), inbound(AIRBNB_MESSAGE, { headers: undefined }));
    expect(result).toMatchObject({ replied: true });
  });
});

describe("a forged sender is stored, never answered", () => {
  for (const [name, headers] of [
    ["no signature at all", {}],
    ["dkim failed", { "authentication-results": ["mx.resend.com; dkim=fail header.d=airbnb.com"] }],
    ["a pass for someone else's domain", { "authentication-results": ["mx.resend.com; dkim=pass header.d=evil.test"] }],
  ] as const) {
    it(`From: airbnb.com with ${name}`, async () => {
      mocks.fetchHeaders.mockResolvedValue(headers);
      const result = await processManagerAssistantInboundEmail(makeDb(), inbound(AIRBNB_MESSAGE));
      expect(result).toMatchObject({ handled: true, replied: false });
      expect(mocks.runLeasingEmailAgentTurn).not.toHaveBeenCalled();
      expect(mocks.reserveCommsCredit).not.toHaveBeenCalled();
      expect(mocks.deliverManagerEmailReply).not.toHaveBeenCalled();
      // Visible in Communication under the (unproven) sender's address, not in a guest's conversation.
      const mirror = mocks.mirrorAssistantEmailConversation.mock.calls[0]![1];
      expect(mirror.senderEmail).toBe("automated@airbnb.com");
      expect(mirror.channelGuest).toBeUndefined();
      expect(mirror.replyText).toBeNull();
    });
  }

  it("a failed header fetch is not a pass", async () => {
    mocks.fetchHeaders.mockRejectedValue(new Error("down"));
    const result = await processManagerAssistantInboundEmail(makeDb(), inbound(AIRBNB_MESSAGE));
    expect(result).toMatchObject({ replied: false });
    expect(mocks.deliverManagerEmailReply).not.toHaveBeenCalled();
  });
});

describe("what is held instead of sent", () => {
  it("a money / refund message is held: stored as a draft with a notice, nothing sent", async () => {
    mocks.runLeasingEmailAgentTurn.mockResolvedValue({ reply: "Thanks for letting us know; your host will follow up personally.", sessionId: "s1", traceId: null, channel: { violations: [], availabilityReplaced: false } });
    const money = { ...AIRBNB_MESSAGE, text: AIRBNB_MESSAGE.text.replace("Hi! Is early check-in possible? I land around 10am.", "I was charged twice, I want a refund.") };
    const result = await processManagerAssistantInboundEmail(makeDb(), inbound(money));
    expect(result).toMatchObject({ handled: true, replied: false, role: "channel" });
    expect(result).toHaveProperty("held");
    expect(mocks.deliverManagerEmailReply).not.toHaveBeenCalled();
    const mirror = mocks.mirrorAssistantEmailConversation.mock.calls[0]![1];
    expect(mirror.replyAsReviewDraft).toBe(true);
    expect(mirror.replyText).toContain("follow up");
    expect(mirror.channelGuest.held).toBe(true);
    expect(mocks.notifyManagerFromAgent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ landlordId: "mgr-1", subject: "Guest message held" }));
    // The agent was told it is a held topic.
    expect(mocks.runLeasingEmailAgentTurn.mock.calls[0]![1].channel.holdReason).toBe("money");
  });

  it.each([
    ["cancellation", "I need to cancel my reservation."],
    ["complaint", "The room was dirty and the heater is broken, this is unacceptable."],
  ])("a %s message is held", async (_reason, body) => {
    const fixture = { ...AIRBNB_MESSAGE, text: AIRBNB_MESSAGE.text.replace("Hi! Is early check-in possible? I land around 10am.", body) };
    const result = await processManagerAssistantInboundEmail(makeDb(), inbound(fixture));
    expect(result.handled && result.replied).toBe(false);
    expect(mocks.deliverManagerEmailReply).not.toHaveBeenCalled();
    expect(mocks.mirrorAssistantEmailConversation.mock.calls[0]![1].replyAsReviewDraft).toBe(true);
  });

  it("a reply that carries a URL / phone / email on Airbnb is held", async () => {
    mocks.runLeasingEmailAgentTurn.mockResolvedValue({
      reply: "Sure, see https://proplane.ai/rent/abc or call (206) 678-1909.",
      sessionId: "s1", traceId: null, channel: { violations: ["link", "phone"], availabilityReplaced: false },
    });
    const result = await processManagerAssistantInboundEmail(makeDb(), inbound(AIRBNB_MESSAGE));
    expect(result).toMatchObject({ replied: false });
    expect(mocks.deliverManagerEmailReply).not.toHaveBeenCalled();
    expect(mocks.mirrorAssistantEmailConversation.mock.calls[0]![1].replyAsReviewDraft).toBe(true);
  });

  it("no relay address (PadSplit) holds the reply for a copy-and-open", async () => {
    mocks.fetchHeaders.mockResolvedValue(SIGNED("padsplit.com"));
    const result = await processManagerAssistantInboundEmail(makeDb(), inbound(PADSPLIT_MESSAGE));
    expect(result).toMatchObject({ replied: false });
    expect(mocks.deliverManagerEmailReply).not.toHaveBeenCalled();
    const mirror = mocks.mirrorAssistantEmailConversation.mock.calls[0]![1];
    expect(mirror.channelGuest).toMatchObject({ site: "padsplit", propertyId: "p5259", replyAddress: null, held: true });
    // PadSplit may carry the PropLane line: the agent was handed it.
    expect(mocks.runLeasingEmailAgentTurn.mock.calls[0]![1].channel.proplaneLine).toBe("(206) 678-1909");
  });

  it("the account's approval setting holds it, and an unreadable setting fails closed", async () => {
    mocks.partyFacingAnswerHold.mockResolvedValue({ hold: true, reason: "approval" });
    await processManagerAssistantInboundEmail(makeDb(), inbound(AIRBNB_MESSAGE));
    expect(mocks.deliverManagerEmailReply).not.toHaveBeenCalled();

    mocks.partyFacingAnswerHold.mockRejectedValue(new Error("unreadable"));
    await processManagerAssistantInboundEmail(makeDb(), inbound(AIRBNB_MESSAGE));
    expect(mocks.deliverManagerEmailReply).not.toHaveBeenCalled();
  });

  it("no credit means no model run and no reply", async () => {
    mocks.reserveCommsCredit.mockResolvedValue({ allowed: false, reason: "insufficient" });
    const result = await processManagerAssistantInboundEmail(makeDb(), inbound(AIRBNB_MESSAGE));
    expect(result).toMatchObject({ replied: false });
    expect(mocks.runLeasingEmailAgentTurn).not.toHaveBeenCalled();
    expect(mocks.mirrorAssistantEmailConversation).toHaveBeenCalledTimes(1);
  });
});

describe("a PropLane-managed workspace browses its own catalog", () => {
  it("passes serviceWorkspace through to the leasing turn", async () => {
    mocks.loadServiceWorkspaceIds.mockResolvedValue(["ws-1"]);
    await processManagerAssistantInboundEmail(makeDb(), inbound(AIRBNB_MESSAGE));
    expect(mocks.runLeasingEmailAgentTurn.mock.calls[0]![1].channel.serviceWorkspace).toBe(true);
  });
});
