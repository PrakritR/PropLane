/**
 * Emailed replies → SMS conversations (`ingestInboundEmailSmsReply`):
 * quoted history stripped, exactly-one-send idempotency via the claimed
 * outbound-mail row, conversation identity preserved, honest failure
 * (bounce email, never a fake sent state) — and the three authorization
 * layers in front of a channel whose token verifies against a spoofable
 * `From`: sender-authentication verdict, single-use reply grant, rate limit.
 *
 * Each case uses its own counterparty phone so the per-conversation rate limit
 * (a real process-wide limiter) only bites in the test that exercises it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { smsReplyGrantRecordId } from "@/lib/inbound-email/sms-reply-grant.server";

const { sendFromManagerMock, bounceMock, fetchBodyMock, fetchHeadersMock } = vi.hoisted(() => ({
  sendFromManagerMock: vi.fn(),
  bounceMock: vi.fn(async () => ({ sent: true })),
  fetchBodyMock: vi.fn(async () => ({ kind: "empty" as const })),
  fetchHeadersMock: vi.fn(async () => ({}) as Record<string, string>),
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
    fetchResendReceivedEmailHeaders: fetchHeadersMock,
  };
});

import { ingestInboundEmailSmsReply } from "@/lib/inbound-email/inbound-email-sms-reply.server";
import type { ParsedInboundEmail } from "@/lib/inbound-email/inbound-email.server";

const MGR = "mgr-1";
const MGR_EMAIL = "manager@example.com";

let phoneSeq = 0;
/** A fresh conversation per test — the rate limiter is keyed on it. */
function nextPhone(): string {
  phoneSeq += 1;
  return `+1425555${String(1000 + phoneSeq)}`;
}

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

type GrantState = "valid" | "expired" | "consumed" | "none";

function grantRow(phone: string, state: GrantState, extra?: Record<string, unknown>) {
  const id = smsReplyGrantRecordId(MGR, phone)!;
  const grantedAt =
    state === "expired"
      ? new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
      : new Date().toISOString();
  return {
    id,
    recipient_email: MGR_EMAIL,
    channel: "sms",
    row_data: {
      id,
      kind: "sms_reply_grant",
      managerUserId: MGR,
      to: phone,
      grantedAt,
      consumedAt: state === "consumed" ? new Date().toISOString() : null,
      ...extra,
    },
  };
}

function seedDb(phone: string, grant: GrantState = "valid", counterpartyRole: string | null = "prospect") {
  return createMemoryDb({
    profiles: [{ id: MGR, email: MGR_EMAIL }],
    manager_sms_messages: [],
    inbound_sms_log: [
      {
        id: "in-1",
        manager_user_id: MGR,
        from_phone: phone,
        to_phone: "+12065550100",
        body: "Can we tour Saturday?",
        counterparty_role: counterpartyRole,
        matched_sender_user_id: null,
        created_at: new Date().toISOString(),
      },
    ],
    portal_outbound_mail_records: grant === "none" ? [] : [grantRow(phone, grant)],
  });
}

function tablesOf(db: unknown): Record<string, Array<Record<string, unknown>>> {
  return (db as { __tables: Record<string, Array<Record<string, unknown>>> }).__tables;
}

beforeEach(() => {
  sendFromManagerMock.mockReset();
  sendFromManagerMock.mockResolvedValue({ ok: true, channel: "twilio", sid: "SM900" });
  bounceMock.mockClear();
  fetchBodyMock.mockReset();
  fetchBodyMock.mockResolvedValue({ kind: "empty" });
  fetchHeadersMock.mockReset();
  // The normal case: Resend exposes no verdict, so the grant is the gate.
  fetchHeadersMock.mockResolvedValue({});
});

describe("ingestInboundEmailSmsReply", () => {
  it("strips quoted history and texts only the new reply, threading the same conversation", async () => {
    const phone = nextPhone();
    const db = seedDb(phone);
    const result = await ingestInboundEmailSmsReply(
      parsedEmail(),
      { managerUserId: MGR, counterpartyPhone: phone },
      db as never,
    );
    expect(result).toMatchObject({ handled: true, sent: true });

    expect(sendFromManagerMock).toHaveBeenCalledTimes(1);
    const send = sendFromManagerMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(send.to).toBe(phone);
    expect(send.text).toBe("Yes — Saturday at 2pm works. See you then!");
    // Threads into the SAME conversation the inbound text lives in.
    expect(send.counterpartyRole).toBe("prospect");

    // Logged as an outbound conversation row with the delivery sid, marked as
    // having come in over email rather than from the portal.
    const rows = tablesOf(db).manager_sms_messages;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: "outbound",
      message_sid: "SM900",
      source: "email_reply",
    });
  });

  it("a redelivered webhook never texts twice (claimed once per email id)", async () => {
    const phone = nextPhone();
    const db = seedDb(phone);
    const first = await ingestInboundEmailSmsReply(
      parsedEmail(),
      { managerUserId: MGR, counterpartyPhone: phone },
      db as never,
    );
    expect(first.sent).toBe(true);
    const second = await ingestInboundEmailSmsReply(
      parsedEmail(),
      { managerUserId: MGR, counterpartyPhone: phone },
      db as never,
    );
    expect(second).toMatchObject({ handled: true, sent: true, idempotent: true });
    expect(sendFromManagerMock).toHaveBeenCalledTimes(1);
  });

  it("falls through (handled:false) when the From no longer matches the manager's email", async () => {
    const phone = nextPhone();
    const db = seedDb(phone);
    const result = await ingestInboundEmailSmsReply(
      parsedEmail({ fromEmail: "someone-else@example.com" }),
      { managerUserId: MGR, counterpartyPhone: phone },
      db as never,
    );
    expect(result).toEqual({ handled: false, sent: false });
    expect(sendFromManagerMock).not.toHaveBeenCalled();
  });

  it("a failed send bounces back to the manager and never logs a sent row", async () => {
    sendFromManagerMock.mockResolvedValue({ ok: false, error: "recipient_opted_out" });
    const phone = nextPhone();
    const db = seedDb(phone);
    const result = await ingestInboundEmailSmsReply(
      parsedEmail(),
      { managerUserId: MGR, counterpartyPhone: phone },
      db as never,
    );
    expect(result).toMatchObject({ handled: true, sent: false, error: "recipient_opted_out" });
    expect(bounceMock).toHaveBeenCalledTimes(1);
    const bounce = bounceMock.mock.calls[0]![0] as { toEmail: string; text: string };
    expect(bounce.toEmail).toBe(MGR_EMAIL);
    expect(bounce.text).toContain("opted out");
    expect(tablesOf(db).manager_sms_messages).toHaveLength(0);
  });

  it("an unreadable body bounces instead of texting nothing", async () => {
    const phone = nextPhone();
    const db = seedDb(phone);
    const result = await ingestInboundEmailSmsReply(
      parsedEmail({ text: undefined, html: undefined }),
      { managerUserId: MGR, counterpartyPhone: phone },
      db as never,
    );
    expect(result).toMatchObject({ handled: true, sent: false, error: "empty_body" });
    expect(sendFromManagerMock).not.toHaveBeenCalled();
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  it("an unexpected throw after the claim bounces instead of vanishing", async () => {
    // The claim is already burned at this point, so a redelivery no-ops — if
    // the throw escaped, the manager's reply would disappear with no signal.
    sendFromManagerMock.mockRejectedValue(new Error("transport exploded"));
    const phone = nextPhone();
    const db = seedDb(phone);
    const result = await ingestInboundEmailSmsReply(
      parsedEmail(),
      { managerUserId: MGR, counterpartyPhone: phone },
      db as never,
    );
    expect(result).toMatchObject({ handled: true, sent: false, error: "ingest_error" });
    expect(bounceMock).toHaveBeenCalledTimes(1);
    const tables = tablesOf(db);
    expect(tables.manager_sms_messages).toHaveLength(0);
    const claim = tables.portal_outbound_mail_records.find((r) =>
      String(r.id).startsWith("sms_email_reply_"),
    );
    expect(claim).toMatchObject({
      row_data: expect.objectContaining({ smsSent: false, smsError: "ingest_error" }),
    });
  });

  it("an unrecognised stored role does not fork the reply into an 'unknown' thread", async () => {
    const phone = nextPhone();
    const db = seedDb(phone, "valid", null);
    const result = await ingestInboundEmailSmsReply(
      parsedEmail(),
      { managerUserId: MGR, counterpartyPhone: phone },
      db as never,
    );
    expect(result).toMatchObject({ handled: true, sent: true });
    expect(sendFromManagerMock.mock.calls[0]![0]).toMatchObject({ counterpartyRole: undefined });
  });

  it("fetches the body from Resend when the webhook carried metadata only", async () => {
    fetchBodyMock.mockResolvedValue({ kind: "body", text: "Fetched reply body." });
    const phone = nextPhone();
    const db = seedDb(phone);
    const result = await ingestInboundEmailSmsReply(
      parsedEmail({ text: undefined, html: undefined }),
      { managerUserId: MGR, counterpartyPhone: phone },
      db as never,
    );
    expect(result).toMatchObject({ handled: true, sent: true });
    expect(sendFromManagerMock.mock.calls[0]![0]).toMatchObject({ text: "Fetched reply body." });
  });
});

describe("ingestInboundEmailSmsReply — sender authentication", () => {
  it("rejects a reply whose authentication-results say it is not that domain", async () => {
    fetchHeadersMock.mockResolvedValue({
      "authentication-results":
        "mx.proplane.test; spf=fail smtp.mailfrom=attacker@evil.test; dkim=none; dmarc=fail header.from=example.com",
    });
    const phone = nextPhone();
    const db = seedDb(phone);
    const result = await ingestInboundEmailSmsReply(
      parsedEmail(),
      { managerUserId: MGR, counterpartyPhone: phone },
      db as never,
    );
    expect(result).toMatchObject({ handled: true, sent: false, error: "auth_failed" });
    expect(sendFromManagerMock).not.toHaveBeenCalled();
    const bounce = bounceMock.mock.calls[0]![0] as { toEmail: string; text: string };
    // Bounced to the account's real address, not to whoever sent the mail.
    expect(bounce.toEmail).toBe(MGR_EMAIL);
    expect(bounce.text).toContain("failed sender authentication");
    expect(tablesOf(db).manager_sms_messages).toHaveLength(0);
  });

  it("a DMARC-verified reply sends without spending a grant", async () => {
    fetchHeadersMock.mockResolvedValue({
      "authentication-results": "mx.proplane.test; dmarc=pass (p=REJECT) header.from=example.com",
    });
    const phone = nextPhone();
    const db = seedDb(phone, "consumed");
    const result = await ingestInboundEmailSmsReply(
      parsedEmail(),
      { managerUserId: MGR, counterpartyPhone: phone },
      db as never,
    );
    expect(result).toMatchObject({ handled: true, sent: true });
  });
});

describe("ingestInboundEmailSmsReply — single-use reply grant", () => {
  it("sends on an unknown verdict when the notification's grant is still open", async () => {
    const phone = nextPhone();
    const db = seedDb(phone, "valid");
    const result = await ingestInboundEmailSmsReply(
      parsedEmail(),
      { managerUserId: MGR, counterpartyPhone: phone },
      db as never,
    );
    expect(result).toMatchObject({ handled: true, sent: true });
    // …and the grant is spent, so it is good for exactly one emailed reply.
    const grant = tablesOf(db).portal_outbound_mail_records.find(
      (r) => r.id === smsReplyGrantRecordId(MGR, phone),
    );
    expect(String((grant?.row_data as Record<string, unknown>).consumedAt ?? "")).not.toBe("");
  });

  it("bounces when no notification ever opened a window for this conversation", async () => {
    const phone = nextPhone();
    const db = seedDb(phone, "none");
    const result = await ingestInboundEmailSmsReply(
      parsedEmail(),
      { managerUserId: MGR, counterpartyPhone: phone },
      db as never,
    );
    expect(result).toMatchObject({ handled: true, sent: false, error: "grant_missing" });
    expect(sendFromManagerMock).not.toHaveBeenCalled();
    expect((bounceMock.mock.calls[0]![0] as { text: string }).text).toContain("Open PropLane");
  });

  it("bounces on a stale grant (an old forwarded notification cannot be replayed)", async () => {
    const phone = nextPhone();
    const db = seedDb(phone, "expired");
    const result = await ingestInboundEmailSmsReply(
      parsedEmail(),
      { managerUserId: MGR, counterpartyPhone: phone },
      db as never,
    );
    expect(result).toMatchObject({ handled: true, sent: false, error: "grant_expired" });
    expect(sendFromManagerMock).not.toHaveBeenCalled();
  });

  it("bounces a second reply to the same notification (single use)", async () => {
    const phone = nextPhone();
    const db = seedDb(phone, "valid");
    const first = await ingestInboundEmailSmsReply(
      parsedEmail({ emailId: "re_first" }),
      { managerUserId: MGR, counterpartyPhone: phone },
      db as never,
    );
    expect(first).toMatchObject({ sent: true });
    const second = await ingestInboundEmailSmsReply(
      parsedEmail({ emailId: "re_second" }),
      { managerUserId: MGR, counterpartyPhone: phone },
      db as never,
    );
    expect(second).toMatchObject({ handled: true, sent: false, error: "grant_consumed" });
    expect(sendFromManagerMock).toHaveBeenCalledTimes(1);
  });
});

describe("ingestInboundEmailSmsReply — per-conversation rate limit", () => {
  it("refuses the fourth emailed reply within the hour", async () => {
    fetchHeadersMock.mockResolvedValue({
      "authentication-results": "mx.proplane.test; dmarc=pass header.from=example.com",
    });
    const phone = nextPhone();
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      const db = seedDb(phone, "valid");
      results.push(
        await ingestInboundEmailSmsReply(
          parsedEmail({ emailId: `re_rate_${i}` }),
          { managerUserId: MGR, counterpartyPhone: phone },
          db as never,
        ),
      );
    }
    expect(results.slice(0, 3).every((r) => r.sent)).toBe(true);
    expect(results[3]).toMatchObject({ handled: true, sent: false, error: "rate_limited" });
    expect(sendFromManagerMock).toHaveBeenCalledTimes(3);
  });
});
