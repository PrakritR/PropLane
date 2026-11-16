// Request parsing (caps, honeypot, control characters), the phone a visitor types (a claim only), and the visitor-safe
// projection of a stored thread (no staff names, no internal turns, no ids beyond the turn's own).
import { describe, expect, it } from "vitest";
import { WEB_CHAT_MAX_BODY, cleanVisitorText, parseWebChatRequest, phoneClaimedInText, visibleTurnsOf } from "@/lib/web-chat/model";

const base = { action: "send", propertyId: "prop_1", body: "Is the room open?", clientMessageId: "client-msg-0001" };

describe("parseWebChatRequest", () => {
  it("accepts a plain send and strips control and bidi characters", () => {
    const parsed = parseWebChatRequest({ ...base, body: "hi\u0000 there‮!" });
    expect(parsed).toMatchObject({ ok: true, value: { action: "send", body: "hi there!", roomId: null } });
  });

  it("refuses an over-long message, an empty one, a bad listing id and a bad client id", () => {
    expect(parseWebChatRequest({ ...base, body: "x".repeat(WEB_CHAT_MAX_BODY + 1) })).toMatchObject({ ok: false });
    expect(parseWebChatRequest({ ...base, body: "   " })).toMatchObject({ ok: false });
    expect(parseWebChatRequest({ ...base, propertyId: "../etc" })).toMatchObject({ ok: false });
    expect(parseWebChatRequest({ ...base, clientMessageId: "x" })).toMatchObject({ ok: false });
  });

  it("answers a filled honeypot silently (a bot learns nothing)", () => {
    expect(parseWebChatRequest({ ...base, website: "http://spam.example" })).toMatchObject({ ok: false, silent: true });
  });

  it("never reads a workspace, owner or phone-of-record from the body of a send", () => {
    const parsed = parseWebChatRequest({ ...base, workspaceId: "w", ownerUserId: "o", landlordId: "l" });
    expect(parsed.ok && Object.keys(parsed.value).sort()).toEqual(["action", "body", "clientMessageId", "propertyId", "roomId"]);
  });

  it("parses the phone steps", () => {
    expect(parseWebChatRequest({ action: "phone_code", propertyId: "p", phone: "(206) 555-0142" })).toMatchObject({ ok: true });
    expect(parseWebChatRequest({ action: "phone_verify", propertyId: "p", phone: "2065550142", otp: "12 34 56" })).toMatchObject({ ok: true, value: { otp: "123456" } });
    expect(parseWebChatRequest({ action: "phone_verify", propertyId: "p", phone: "2065550142", otp: "" })).toMatchObject({ ok: false });
    expect(parseWebChatRequest({ action: "wat", propertyId: "p" })).toMatchObject({ ok: false });
  });

  it("caps text at the limit", () => {
    expect(cleanVisitorText("a".repeat(5000), 10)).toHaveLength(10);
  });
});

describe("phoneClaimedInText", () => {
  it("finds a US number in several shapes and nothing else", () => {
    expect(phoneClaimedInText("call me at (206) 555-0142 please")).toBe("2065550142");
    expect(phoneClaimedInText("+1 206.555.0142")).toBe("2065550142");
    expect(phoneClaimedInText("rent is 1200 a month")).toBeNull();
  });
});

describe("visibleTurnsOf", () => {
  const rowData = {
    rootMessageId: "m1", from: "Web visitor", body: "Hello", rootAt: "Nov 15, 9:00 AM", rootOutbound: false,
    ownerUserId: "owner-secret", workspaceId: "ws-secret", smsNoticePhone: "+12065550142",
    messages: [
      { id: "m2", from: "You · Assistant", body: "Hi! Which room?", at: "Nov 15, 9:01 AM", outbound: true, automated: true },
      { id: "m3", from: "Dana Manager", body: "I can show it Friday", at: "Nov 15, 9:05 AM", senderUserId: "staff-user-id" },
      { id: "m4", from: "Dana Manager", body: "internal: low credit score", at: "x", senderUserId: "u", internal: true },
      { id: "m5", from: "Web visitor", body: "Thanks", at: "Nov 15, 9:06 AM", outbound: false },
      { id: "m6", from: "x", body: "   ", at: "x" },
    ],
  };
  it("labels who spoke, drops internal and empty turns, and exposes only id, role, body and time", () => {
    const turns = visibleTurnsOf(rowData, "You · Assistant");
    expect(turns.map((t) => [t.id, t.role])).toEqual([["m1", "visitor"], ["m2", "assistant"], ["m3", "team"], ["m5", "visitor"]]);
    const json = JSON.stringify(turns);
    for (const secret of ["owner-secret", "ws-secret", "+12065550142", "Dana", "staff-user-id", "low credit"]) expect(json).not.toContain(secret);
    expect(Object.keys(turns[0]).sort()).toEqual(["at", "body", "id", "role"]);
  });
  it("keeps only the most recent turns", () => {
    const many = { rootMessageId: "r", body: "b", messages: Array.from({ length: 100 }, (_, i) => ({ id: `x${i}`, body: `t${i}`, from: "v" })) };
    expect(visibleTurnsOf(many, "A", 60)).toHaveLength(60);
  });
});
