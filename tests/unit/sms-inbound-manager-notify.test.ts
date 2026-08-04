/**
 * Inbound SMS → manager notification fan-out (`notifyManagerOfInboundSms`):
 * the inbox notice is written AND the manager is emailed a copy whose
 * Reply-To carries the signed SMS-conversation token, with a stable
 * per-conversation threading anchor. Sandbox emails never leave the building.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { notifyManagerOfInboundSms } from "@/lib/sms-inbox-notice.server";
import { parseSmsReplyAddress } from "@/lib/inbound-email/reply-address.server";
import { smsReplyGrantRecordId } from "@/lib/inbound-email/sms-reply-grant.server";

const MGR = "0f8fad5b-d9cb-469f-a165-70867728950e";
const MGR_EMAIL = "manager@example.com";
const PHONE = "+14255550123";

const ORIG = { ...process.env };
const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ id: "re_1" }) }));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.RESEND_FROM = "PropLane <notify@prop-lane.space>";
  process.env.RESEND_REPLY_DOMAIN = "reply.prop-lane.space";
  process.env.RESEND_INBOUND_WEBHOOK_SECRET = `whsec_${Buffer.from("test-secret").toString("base64")}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIG };
});

function seedDb(email = MGR_EMAIL) {
  return createMemoryDb({
    profiles: [{ id: MGR, email }],
    portal_inbox_thread_records: [],
  });
}

describe("notifyManagerOfInboundSms", () => {
  it("writes the inbox notice and emails a reply-tokened copy", async () => {
    const db = seedDb();
    const result = await notifyManagerOfInboundSms(db as never, {
      managerUserId: MGR,
      fromPhone: PHONE,
      text: "Can we tour Saturday?",
      autoReply: "Sure — pick a time here: …",
      subjectLabel: "Tour request",
      propertyLabel: "Magnolia House",
    });
    expect(result).toEqual({ inboxNoticeWritten: true, emailSent: true });

    // Inbox notice row landed.
    const notices = (db as unknown as { __tables: Record<string, Array<Record<string, unknown>>> })
      .__tables.portal_inbox_thread_records;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ owner_user_id: MGR });

    // Email leg: one Resend call, addressed to the manager, reply-tokened.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1]!["body" as never])) as {
      to: string[];
      subject: string;
      text: string;
      reply_to?: string;
      headers?: Record<string, string>;
    };
    expect(body.to).toEqual([MGR_EMAIL]);
    expect(body.subject).toContain("Tour request");
    expect(body.subject).toContain("Magnolia House");
    expect(body.text).toContain("Can we tour Saturday?");
    expect(body.text).toContain("PropLane auto-replied:");
    // The Reply-To resolves back to THIS conversation for THIS manager.
    expect(body.reply_to).toBeTruthy();
    expect(parseSmsReplyAddress([body.reply_to!], MGR_EMAIL)).toEqual({
      managerUserId: MGR,
      counterpartyPhone: PHONE,
    });
    // Threading anchor groups every text from this counterparty in one thread.
    expect(body.headers?.["In-Reply-To"]).toMatch(/^<pl-sms-anchor-/);
    expect(body.headers?.References).toBe(body.headers?.["In-Reply-To"]);

    // The notification is what authorizes ONE emailed reply back into this
    // conversation — the token alone verifies only a spoofable From header.
    const grants = (db as unknown as { __tables: Record<string, Array<Record<string, unknown>>> })
      .__tables.portal_outbound_mail_records;
    expect(grants).toHaveLength(1);
    expect(grants[0]!.id).toBe(smsReplyGrantRecordId(MGR, PHONE));
    expect(grants[0]!.row_data).toMatchObject({ kind: "sms_reply_grant", allowance: 1 });
  });

  it("opens no reply window when the email never went out", async () => {
    const db = seedDb("demo@test.proplane.local");
    await notifyManagerOfInboundSms(db as never, {
      managerUserId: MGR,
      fromPhone: PHONE,
      text: "hi",
    });
    const tables = (db as unknown as { __tables: Record<string, Array<Record<string, unknown>>> })
      .__tables;
    expect(tables.portal_outbound_mail_records ?? []).toHaveLength(0);
  });

  it("never emails a sandbox account, and still writes the notice", async () => {
    const db = seedDb("demo@test.proplane.local");
    const result = await notifyManagerOfInboundSms(db as never, {
      managerUserId: MGR,
      fromPhone: PHONE,
      text: "hi",
    });
    expect(result).toEqual({ inboxNoticeWritten: true, emailSent: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skipInboxNotice sends only the email leg (caller wrote its own notice)", async () => {
    const db = seedDb();
    const result = await notifyManagerOfInboundSms(db as never, {
      managerUserId: MGR,
      fromPhone: PHONE,
      text: "hi",
      skipInboxNotice: true,
    });
    expect(result).toEqual({ inboxNoticeWritten: false, emailSent: true });
    const notices = (db as unknown as { __tables: Record<string, Array<Record<string, unknown>>> })
      .__tables.portal_inbox_thread_records;
    expect(notices).toHaveLength(0);
  });

  it("co-manager copies get portal-only Reply-To, plain portal copy, and no grant", async () => {
    const db = seedDb();
    const result = await notifyManagerOfInboundSms(db as never, {
      managerUserId: MGR,
      fromPhone: PHONE,
      text: "Can we tour Saturday?",
      includeSmsReplyToken: false,
    });
    expect(result).toEqual({ inboxNoticeWritten: true, emailSent: true });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1]!["body" as never])) as {
      text: string;
      reply_to?: string;
    };
    expect(body.reply_to).toMatch(/^smsp\+/);
    expect(body.text).toContain("will NOT reach the renter");
    expect(body.text).toContain("/portal/communication");
    expect(parseSmsReplyAddress([body.reply_to!], MGR_EMAIL)).toBeNull();
    const tables = (db as unknown as { __tables: Record<string, Array<Record<string, unknown>>> })
      .__tables;
    expect(tables.portal_outbound_mail_records ?? []).toHaveLength(0);
  });
});
