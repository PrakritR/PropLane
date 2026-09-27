import { describe, expect, it } from "vitest";
import { isTwilioMessageSid } from "@/lib/sms/message-sid";

describe("Twilio Message SID", () => {
  it.each(["SM", "MM"])("accepts exact %s Message resource identifiers", (prefix) => {
    expect(isTwilioMessageSid(`${prefix}${"aB09".repeat(8)}`)).toBe(true);
  });

  it.each([null, 10, "", `SM${"a".repeat(31)}`, `MM${"a".repeat(33)}`,
    `MM${"g".repeat(32)}`, `PM${"a".repeat(32)}`, `mm${"a".repeat(32)}`])("rejects non-Message identifier %s", (sid) => {
    expect(isTwilioMessageSid(sid)).toBe(false);
  });
});
