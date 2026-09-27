import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildReplyAddress,
  conversationAnchorMessageId,
  parseReplyAddress,
} from "@/lib/inbound-email/reply-address.server";

const SECRET = `whsec_${Buffer.from("reply-address-test-key").toString("base64")}`;
const SENDER = "3f9a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8";
const RECIPIENT = "resident@example.com";
const ENV = ["RESEND_REPLY_DOMAIN", "RESEND_INBOUND_WEBHOOK_SECRET"] as const;

describe("reply-address", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of ENV) saved.set(k, process.env[k]);
    process.env.RESEND_REPLY_DOMAIN = "in.prop-lane.space";
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    for (const k of ENV) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("round-trips: a built address verifies against the same From", () => {
    const address = buildReplyAddress(SENDER, RECIPIENT);
    // Lowercase hex only — the local part must survive being lowercased in transit.
    expect(address).toMatch(/^reply\+[0-9a-f]{32}\.[0-9a-f]{16}@in\.prop-lane\.space$/);
    expect(parseReplyAddress([address!], RECIPIENT)).toEqual({ ownerUserId: SENDER });
  });

  it("keeps the local part within the RFC 64-char bound", () => {
    const address = buildReplyAddress(SENDER, RECIPIENT)!;
    expect(address.split("@")[0]!.length).toBeLessThanOrEqual(64);
  });

  it("verifies case-insensitively on From and address", () => {
    const address = buildReplyAddress(SENDER, "Resident@Example.com")!;
    expect(parseReplyAddress([address.toUpperCase()], "RESIDENT@example.COM")).toEqual({
      ownerUserId: SENDER,
    });
  });

  it("finds the token among several To addresses", () => {
    const address = buildReplyAddress(SENDER, RECIPIENT)!;
    expect(parseReplyAddress(["support@proplane.ai", address], RECIPIENT)).toEqual({
      ownerUserId: SENDER,
    });
  });

  it("rejects a reply From an address the MAC was not bound to", () => {
    const address = buildReplyAddress(SENDER, RECIPIENT)!;
    expect(parseReplyAddress([address], "someone-else@example.com")).toBeNull();
  });

  it("rejects a tampered MAC", () => {
    const address = buildReplyAddress(SENDER, RECIPIENT)!;
    const [local, domain] = address.split("@") as [string, string];
    const flipped = local.slice(0, -1) + (local.endsWith("A") ? "B" : "A");
    expect(parseReplyAddress([`${flipped}@${domain}`], RECIPIENT)).toBeNull();
  });

  it("rejects a swapped-in owner uuid (MAC binds the pair)", () => {
    const other = "00000000-0000-4000-8000-000000000001";
    const address = buildReplyAddress(SENDER, RECIPIENT)!;
    const otherAddress = buildReplyAddress(other, RECIPIENT)!;
    const mac = address.split("@")[0]!.split(".")[1]!;
    const otherEncoded = otherAddress.split("@")[0]!.split(".")[0]!;
    expect(parseReplyAddress([`${otherEncoded}.${mac}@in.prop-lane.space`], RECIPIENT)).toBeNull();
  });

  it("ignores addresses on other domains and non-reply local parts", () => {
    expect(parseReplyAddress(["reply+abc.def@evil.example.com"], RECIPIENT)).toBeNull();
    expect(parseReplyAddress(["support@in.prop-lane.space"], RECIPIENT)).toBeNull();
  });

  it("is dark when RESEND_REPLY_DOMAIN is unset", () => {
    const address = buildReplyAddress(SENDER, RECIPIENT)!;
    delete process.env.RESEND_REPLY_DOMAIN;
    expect(buildReplyAddress(SENDER, RECIPIENT)).toBeNull();
    expect(parseReplyAddress([address], RECIPIENT)).toBeNull();
  });

  it("is dark when the webhook secret is unset", () => {
    delete process.env.RESEND_INBOUND_WEBHOOK_SECRET;
    expect(buildReplyAddress(SENDER, RECIPIENT)).toBeNull();
  });

  it("returns null for a non-uuid sender id", () => {
    expect(buildReplyAddress("not-a-uuid", RECIPIENT)).toBeNull();
  });

  it("anchor is deterministic per pair and distinct across pairs", () => {
    const a1 = conversationAnchorMessageId(SENDER, RECIPIENT, "prop-lane.space");
    const a2 = conversationAnchorMessageId(SENDER, RECIPIENT, "prop-lane.space");
    const b = conversationAnchorMessageId(SENDER, "other@example.com", "prop-lane.space");
    expect(a1).toBe(a2);
    expect(a1).toMatch(/^<pl-anchor-[0-9a-f]{24}@prop-lane\.space>$/);
    expect(b).not.toBe(a1);
  });
});
