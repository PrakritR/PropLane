import { describe, expect, it } from "vitest";
import { inboxReplySentToastMessage } from "@/lib/inbox-reply-outcome";

describe("inboxReplySentToastMessage", () => {
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
