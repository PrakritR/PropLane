import { describe, expect, it } from "vitest";
import { isGsm7 } from "@/lib/one-number/segments";
import { estimateSmsSegments } from "@/lib/sms/number-registration-policy";
import {
  composeRentReminderSms,
  fillPayLinkToken,
  smsReminderLead,
  textUsesPayLinkToken,
  truncateOnWord,
} from "@/lib/payments/rent-reminder-sms";

const ORIGIN = "https://proplane.ai";
const LINK = "https://proplane.ai/l/Zk3T9v1q8mY2nB7cX4wR6pD0sL5hJ1aF3gU9eO8iKt";
const EMAIL_BODY = [
  "Hi Maya,",
  "",
  "This is a reminder that your October rent payment is due in 3 days (Nov 1).",
  "",
  "How to sign in to PropLane:",
  "• Open: https://proplane.ai/login",
  "• Use the same email we have on file (maya@example.com).",
].join("\n");

describe("smsReminderLead", () => {
  it("drops the email-only sign-in block and folds the prose into one line", () => {
    expect(smsReminderLead(EMAIL_BODY)).toBe("Hi Maya, This is a reminder that your October rent payment is due in 3 days (Nov 1).");
  });

  it("is GSM-7: curly quotes, long dashes, bullets and emoji are normalized", () => {
    const lead = smsReminderLead("Maya’s rent — due “today” • pay now 😀");
    expect(isGsm7(lead)).toBe(true);
    expect(lead).toBe("Maya's rent - due \"today\" - pay now");
  });

  it("removes a {pay_link} token and the label it leaves behind", () => {
    expect(smsReminderLead("Hi Maya, rent of $850 is due Nov 1. Pay here: {pay_link}")).toBe("Hi Maya, rent of $850 is due Nov 1.");
  });
});

describe("pay link token", () => {
  it("is filled for real, in any spelling, and detected", () => {
    expect(textUsesPayLinkToken("Pay: {pay_link}")).toBe(true);
    expect(textUsesPayLinkToken("Pay: {payLink}")).toBe(true);
    expect(textUsesPayLinkToken("Pay in the app")).toBe(false);
    expect(fillPayLinkToken("Pay here: {pay_link} {payLink}", "https://proplane.ai/x")).toBe("Pay here: https://proplane.ai/x https://proplane.ai/x");
  });
});

describe("truncateOnWord", () => {
  it("never cuts a word in half and says it was shortened", () => {
    const long = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango";
    const cut = truncateOnWord(long, 60);
    expect(cut.endsWith("...")).toBe(true);
    expect(estimateSmsSegments(cut).encodedUnits).toBeLessThanOrEqual(60);
    for (const word of cut.replace(/\.\.\.$/, "").split(" ")) expect(long.split(" ")).toContain(word);
  });
  it("leaves a short text alone", () => {
    expect(truncateOnWord("Rent is due.", 160)).toBe("Rent is due.");
  });
});

describe("composeRentReminderSms", () => {
  it("is the lead, then the label and the link each on their own line, within two segments", () => {
    const body = composeRentReminderSms({ text: EMAIL_BODY, payLink: LINK, canonicalOrigin: ORIGIN });
    const lines = body.split("\n");
    expect(lines.at(-1)).toBe(LINK);
    expect(lines.at(-2)).toBe("Pay here:");
    expect(isGsm7(body)).toBe(true);
    expect(estimateSmsSegments(body).segmentCount).toBeLessThanOrEqual(2);
    expect(body).not.toContain("How to sign in");
  });

  it("a very long body is cut on a word boundary and the link always survives whole", () => {
    const text = `Hi Maya, ${"your rent for the big house on the hill is due soon and ".repeat(20)}end`;
    const body = composeRentReminderSms({ text, payLink: LINK, canonicalOrigin: ORIGIN });
    expect(body.endsWith(LINK)).toBe(true);
    expect(estimateSmsSegments(body).segmentCount).toBeLessThanOrEqual(2);
    expect(body).toContain("...\nPay here:\n");
    const lead = body.split("\nPay here:")[0]!.replace(/\.\.\.$/, "");
    expect(text.startsWith(lead.trim())).toBe(true);
    expect(/\s$/.test(lead)).toBe(false);
  });

  it("with no link the text is just the lead, in at most two segments", () => {
    const body = composeRentReminderSms({ text: EMAIL_BODY, payLink: null, canonicalOrigin: ORIGIN });
    expect(body).toBe("Hi Maya, This is a reminder that your October rent payment is due in 3 days (Nov 1).");
  });

  it("puts a non-canonical host on the canonical one", () => {
    const body = composeRentReminderSms({ text: "Rent is due.", payLink: "https://proplane-x.vercel.app/l/tok", canonicalOrigin: ORIGIN });
    expect(body.split("\n").at(-1)).toBe("https://proplane.ai/l/tok");
  });

  it("a template that already says 'Pay here: {pay_link}' does not say it twice", () => {
    const body = composeRentReminderSms({ text: "Hi Maya, rent of $850 is due Nov 1. Pay here: {pay_link}", payLink: LINK, canonicalOrigin: ORIGIN });
    expect(body).toBe(`Hi Maya, rent of $850 is due Nov 1.\nPay here:\n${LINK}`);
  });
});
