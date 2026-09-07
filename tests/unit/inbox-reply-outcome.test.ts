import { describe, expect, it } from "vitest";
import { inboxReplySentToastMessage } from "@/lib/inbox-reply-outcome";

describe("inboxReplySentToastMessage", () => {
  it.each([
    [false, false, true, false, false, "Reply sent via PropLane."],
    [true, false, true, false, false, "Reply sent via PropLane. Email failed."],
    [true, true, true, true, false, "Reply sent via PropLane and email. Text message failed."],
    [true, true, true, true, true, "Reply sent via PropLane, email and text."],
    [true, false, false, true, false, "Reply sent via email. PropLane message failed."],
    [false, false, false, false, false, "Could not send reply."],
  ])("includes PropLane in accepted and partial sends (%s %s %s %s %s)",
    (emailRequested, smsRequested, proplaneOk, emailOk, smsOk, expected) => {
      expect(inboxReplySentToastMessage({
        emailRequested, smsRequested, proplaneRequested: true, proplaneOk, emailOk, smsOk,
      })).toBe(expected);
    });

  it("does not encourage resending an unknown text after PropLane succeeds", () => {
    expect(inboxReplySentToastMessage({
      emailRequested: false, smsRequested: true, proplaneRequested: true,
      emailOk: false, smsOk: false, proplaneOk: true, smsUnknown: true,
    })).toBe("Reply sent via PropLane. Text delivery could not be confirmed—do not resend it; check the conversation later.");
  });
  it.each([
    [true, false, true, false, "Reply sent."],
    [false, true, false, true, "Reply sent via text."],
    [true, true, true, true, "Reply sent via email and text."],
    [true, true, true, false, "Reply sent via email. Text message failed."],
    [true, true, false, true, "Reply sent via text. Email failed."],
    [true, true, false, false, "Could not send reply."],
  ])(
    "reports requested email=%s sms=%s from actual email=%s sms=%s outcomes",
    (emailRequested, smsRequested, emailOk, smsOk, expected) => {
      expect(
        inboxReplySentToastMessage({
          emailRequested,
          smsRequested,
          emailOk,
          smsOk,
        }),
      ).toBe(expected);
    },
  );
});
