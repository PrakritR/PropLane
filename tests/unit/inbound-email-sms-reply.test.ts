/**
 * Emailed replies → SMS conversations (`ingestInboundEmailSmsReply`):
 * quoted history stripped, exactly-one-send idempotency via the claimed
 * outbound-mail row, conversation identity preserved, and honest failure
 * (bounce email, never a fake sent state).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const { sendFromManagerMock, bounceMock, fetchBodyMock } = vi.hoisted(() => ({
  sendFromManagerMock: vi.fn(),
  bounceMock: vi.fn(async () => ({ sent: true })),
  fetchBodyMock: vi.fn(async () => ({ kind: "empty" as const })),
}));

vi.mock("@/lib/proplane-sms-transport.server", () => ({
  sendFromManagerWorkNumber: sendFromManagerMock,
}));

vi.mock("@/lib/sms-inbox-notice.server", () => ({
  sendManagerNoticeEmail: bounceMock,
  upsertManagerInboxNotice: vi.fn(async () => undefined),
  notifyManagerOfInboundSms: vi.fn(async () => ({ inboxNoticeWritten: true, emailSent: false })),
}));

vi.mock("@/lib/inbound-email/inbound-email.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/inbound-email/inbound-email.server")>();
  return {
    ...original,
    fetchResendReceivedEmailBodyWithRetry: fetchBodyMock,
  };
});

import { ingestInboundEmailSmsReply } from "@/lib/inbound-email/inbound-email-sms-reply.server";
import type { ParsedInboundEmail } from "@/lib/inbound-email/inbound-email.server";

const MGR = "mgr-1";
const MGR_EMAIL = "manager@example.com";
const PHONE = "+14255550123";

function parsedEmail(overrides?: Partial<ParsedInboundEmail>): ParsedInboundEmail {
  return {
    emailId: "re_abc123",
    fromEmail: MGR_EMAIL,
    fromName: "Manager",
    toEmails: [`sms+deadbeef.cafe@reply.prop-lane.space`],
    subject: "Re: (Resident text) +1 (425) 555-0123",
    receivedAt: new Date().toISOString(),
    text: [
      "Yes — Saturday at 2pm works. See you then!",
      "",
      "On Mon, Aug 3, 2026 at 5:01 PM PropLane <notify@prop-lane.space> wrote:",
      "> +14255550123 texted your PropLane number:",
      "> Can we tour Saturday?",
    ].join("\n"),
    ...overrides,
  };
}

function seedDb() {
  return createMemoryDb({
    profiles: [{ id: MGR, email: MGR_EMAIL }],
    manager_sms_messages: [],
    inbound_sms_log: [
      {
        id: "in-1",
        manager_user_id: MGR,
        from_phone: PHONE,
        to_phone: "+12065550100",
        body: "Can we tour Saturday?",
        counterparty_role: "prospect",
        matched_sender_user_id: null,
        created_at: new Date().toISOString(),
      },
    ],
    portal_outbound_mail_records: [],
  });
}

beforeEach(() => {
  sendFromManagerMock.mockReset();
  sendFromManagerMock.mockResolvedValue({ ok: true, channel: "twilio", sid: "SM900" });
  bounceMock.mockClear();
  fetchBodyMock.mockReset();
  fetchBodyMock.mockResolvedValue({ kind: "empty" });
});

describe("ingestInboundEmailSmsReply", () => {
  it("strips quoted history and texts only the new reply, threading the same conversation", async () => {
    const db = seedDb();
    const result = await ingestInboundEmailSmsReply(
      parsedEmail(),
      { managerUserId: MGR, counterpartyPhone: PHONE },
      db as never,
    );
    expect(result).toMatchObject({ handled: true, sent: true });

    expect(sendFromManagerMock).toHaveBeenCalledTimes(1);
    const send = sendFromManagerMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(send.to).toBe(PHONE);
    expect(send.text).toBe("Yes — Saturday at 2pm works. See you then!");
    // Threads into the SAME conversation the inbound text lives in.
    expect(send.counterpartyRole).toBe("prospect");

    // Logged as an outbound conversation row with the delivery sid.
    const rows = (db as unknown as { __tables: Record<string, Array<Record<string, unknown>>> })
      .__tables.manager_sms_messages;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: "outbound", message_sid: "SM900" });
  });

  it("a redelivered webhook never texts twice (claimed once per email id)", async () => {
    const db = seedDb();
    const first = await ingestInboundEmailSmsReply(
      parsedEmail(),
      { managerUserId: MGR, counterpartyPhone: PHONE },
      db as never,
    );
    expect(first.sent).toBe(true);
    const second = await ingestInboundEmailSmsReply(
      parsedEmail(),
      { managerUserId: MGR, counterpartyPhone: PHONE },
      db as never,
    );
    expect(second).toMatchObject({ handled: true, sent: true, idempotent: true });
    expect(sendFromManagerMock).toHaveBeenCalledTimes(1);
  });

  it("falls through (handled:false) when the From no longer matches the manager's email", async () => {
    const db = seedDb();
    const result = await ingestInboundEmailSmsReply(
      parsedEmail({ fromEmail: "someone-else@example.com" }),
      { managerUserId: MGR, counterpartyPhone: PHONE },
      db as never,
    );
    expect(result).toEqual({ handled: false, sent: false });
    expect(sendFromManagerMock).not.toHaveBeenCalled();
  });

  it("a failed send bounces back to the manager and never logs a sent row", async () => {
    sendFromManagerMock.mockResolvedValue({ ok: false, error: "recipient_opted_out" });
    const db = seedDb();
    const result = await ingestInboundEmailSmsReply(
      parsedEmail(),
      { managerUserId: MGR, counterpartyPhone: PHONE },
      db as never,
    );
    expect(result).toMatchObject({ handled: true, sent: false, error: "recipient_opted_out" });
    expect(bounceMock).toHaveBeenCalledTimes(1);
    const bounce = bounceMock.mock.calls[0]![0] as { toEmail: string; text: string };
    expect(bounce.toEmail).toBe(MGR_EMAIL);
    expect(bounce.text).toContain("opted out");
    const rows = (db as unknown as { __tables: Record<string, Array<Record<string, unknown>>> })
      .__tables.manager_sms_messages;
    expect(rows).toHaveLength(0);
  });

  it("an unreadable body bounces instead of texting nothing", async () => {
    const db = seedDb();
    const result = await ingestInboundEmailSmsReply(
      parsedEmail({ text: undefined, html: undefined }),
      { managerUserId: MGR, counterpartyPhone: PHONE },
      db as never,
    );
    expect(result).toMatchObject({ handled: true, sent: false, error: "empty_body" });
    expect(sendFromManagerMock).not.toHaveBeenCalled();
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  it("fetches the body from Resend when the webhook carried metadata only", async () => {
    fetchBodyMock.mockResolvedValue({ kind: "body", text: "Fetched reply body." });
    const db = seedDb();
    const result = await ingestInboundEmailSmsReply(
      parsedEmail({ text: undefined, html: undefined }),
      { managerUserId: MGR, counterpartyPhone: PHONE },
      db as never,
    );
    expect(result).toMatchObject({ handled: true, sent: true });
    expect(sendFromManagerMock.mock.calls[0]![0]).toMatchObject({ text: "Fetched reply body." });
  });
});
