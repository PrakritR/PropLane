import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSmsPortalOnlyReplyAddress,
  buildSmsReplyAddress,
  parseSmsPortalOnlyReplyAddress,
  parseSmsReplyAddress,
  smsConversationAnchorMessageId,
} from "@/lib/inbound-email/reply-address.server";

const MGR = "0f8fad5b-d9cb-469f-a165-70867728950e";
const MGR_EMAIL = "manager@example.com";
const PHONE = "+14255550123";

const ORIG = {
  domain: process.env.RESEND_REPLY_DOMAIN,
  secret: process.env.RESEND_INBOUND_WEBHOOK_SECRET,
};

beforeEach(() => {
  process.env.RESEND_REPLY_DOMAIN = "reply.prop-lane.space";
  process.env.RESEND_INBOUND_WEBHOOK_SECRET = `whsec_${Buffer.from("test-secret-key-material").toString("base64")}`;
});

afterEach(() => {
  if (ORIG.domain === undefined) delete process.env.RESEND_REPLY_DOMAIN;
  else process.env.RESEND_REPLY_DOMAIN = ORIG.domain;
  if (ORIG.secret === undefined) delete process.env.RESEND_INBOUND_WEBHOOK_SECRET;
  else process.env.RESEND_INBOUND_WEBHOOK_SECRET = ORIG.secret;
});

describe("buildSmsReplyAddress / parseSmsReplyAddress", () => {
  it("round-trips: the built address verifies against the manager's From", () => {
    const address = buildSmsReplyAddress(MGR, MGR_EMAIL, PHONE);
    expect(address).toBeTruthy();
    expect(address).toMatch(/^sms\+[0-9a-f]{32}\d{10}\.[0-9a-f]{16}@reply\.prop-lane\.space$/);
    // RFC local-part bound.
    expect(address!.split("@")[0]!.length).toBeLessThanOrEqual(64);

    const parsed = parseSmsReplyAddress([address!], MGR_EMAIL);
    expect(parsed).toEqual({ managerUserId: MGR, counterpartyPhone: PHONE });
  });

  it("accepts 10/11-digit phone shapes and normalizes to E.164", () => {
    for (const phone of ["4255550123", "14255550123", "(425) 555-0123"]) {
      const address = buildSmsReplyAddress(MGR, MGR_EMAIL, phone);
      expect(address, phone).toBeTruthy();
      expect(parseSmsReplyAddress([address!], MGR_EMAIL)?.counterpartyPhone).toBe(PHONE);
    }
  });

  it("does not verify for a different From (the MAC binds the manager email)", () => {
    const address = buildSmsReplyAddress(MGR, MGR_EMAIL, PHONE)!;
    expect(parseSmsReplyAddress([address], "attacker@example.com")).toBeNull();
  });

  it("rejects a tampered phone or MAC", () => {
    const address = buildSmsReplyAddress(MGR, MGR_EMAIL, PHONE)!;
    const [local, domain] = address.split("@") as [string, string];
    const tamperedPhone = `${local.slice(0, 4 + 32)}4255550999.${local.split(".")[1]}@${domain}`;
    expect(parseSmsReplyAddress([tamperedPhone], MGR_EMAIL)).toBeNull();
    const tamperedMac = `${local.split(".")[0]}.${"0".repeat(16)}@${domain}`;
    expect(parseSmsReplyAddress([tamperedMac], MGR_EMAIL)).toBeNull();
  });

  it("is dark (null / no match) when the reply domain is unset", () => {
    delete process.env.RESEND_REPLY_DOMAIN;
    expect(buildSmsReplyAddress(MGR, MGR_EMAIL, PHONE)).toBeNull();
    expect(parseSmsReplyAddress([`sms+abc@reply.prop-lane.space`], MGR_EMAIL)).toBeNull();
  });

  it("returns null for a non-US phone or a non-uuid manager id", () => {
    expect(buildSmsReplyAddress(MGR, MGR_EMAIL, "+447911123456")).toBeNull();
    expect(buildSmsReplyAddress("not-a-uuid", MGR_EMAIL, PHONE)).toBeNull();
  });

  it("ignores portal reply+ tokens (distinct prefix)", () => {
    expect(
      parseSmsReplyAddress([`reply+${"a".repeat(32)}.${"b".repeat(16)}@reply.prop-lane.space`], MGR_EMAIL),
    ).toBeNull();
  });
});

describe("buildSmsPortalOnlyReplyAddress / parseSmsPortalOnlyReplyAddress", () => {
  it("round-trips under the smsp+ prefix and never parses as a sendable sms+ token", () => {
    const address = buildSmsPortalOnlyReplyAddress(MGR, MGR_EMAIL, PHONE);
    expect(address).toBeTruthy();
    expect(address).toMatch(/^smsp\+[0-9a-f]{32}\d{10}\.[0-9a-f]{16}@reply\.prop-lane\.space$/);
    expect(address!.split("@")[0]!.length).toBeLessThanOrEqual(64);
    expect(parseSmsPortalOnlyReplyAddress([address!], MGR_EMAIL)).toEqual({
      managerUserId: MGR,
      counterpartyPhone: PHONE,
    });
    // Distinct prefixes: a portal-only address must not verify as sendable.
    expect(parseSmsReplyAddress([address!], MGR_EMAIL)).toBeNull();
    const sendable = buildSmsReplyAddress(MGR, MGR_EMAIL, PHONE)!;
    expect(parseSmsPortalOnlyReplyAddress([sendable], MGR_EMAIL)).toBeNull();
  });

  it("rejects a mismatched From (MAC binds the recipient email)", () => {
    const address = buildSmsPortalOnlyReplyAddress(MGR, MGR_EMAIL, PHONE)!;
    expect(parseSmsPortalOnlyReplyAddress([address], "other@example.com")).toBeNull();
  });
});

describe("smsConversationAnchorMessageId", () => {
  it("is deterministic per (manager, phone) and differs across counterparties", () => {
    const a1 = smsConversationAnchorMessageId(MGR, PHONE, "prop-lane.space");
    const a2 = smsConversationAnchorMessageId(MGR, "4255550123", "prop-lane.space");
    const b = smsConversationAnchorMessageId(MGR, "+14255550999", "prop-lane.space");
    expect(a1).toBe(a2); // phone-shape independent
    expect(a1).not.toBe(b);
    expect(a1).toMatch(/^<pl-sms-anchor-[0-9a-f]{24}@prop-lane\.space>$/);
  });
});
