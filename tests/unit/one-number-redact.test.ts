import { describe, expect, it } from "vitest";
import {
  REDACTION_MARK,
  SECURE_PAYMENT_REPLY,
  isValidAbaRouting,
  passesLuhn,
  redactSensitiveNumbers,
} from "@/lib/one-number/redact";

describe("one-number redaction", () => {
  it("redacts a Luhn-valid card number in every common spacing", () => {
    for (const card of ["4242424242424242", "4242 4242 4242 4242", "4242-4242-4242-4242", "378282246310005"]) {
      const r = redactSensitiveNumbers(`my card is ${card} exp 12/29`);
      expect(r.text).toBe(`my card is ${REDACTION_MARK} exp 12/29`);
      expect(r.redacted).toBe(true);
      expect(r.kinds).toEqual(["card"]);
    }
  });

  it("leaves a long digit run that fails Luhn alone", () => {
    const r = redactSensitiveNumbers("order 4242424242424241 shipped");
    expect(r.redacted).toBe(false);
    expect(r.text).toBe("order 4242424242424241 shipped");
  });

  it("does not touch phone numbers, dates, rents or zip codes", () => {
    const body = "Call 206-555-0100 or (425) 555 0199, rent is 1250 due 10/01, zip 98105";
    expect(redactSensitiveNumbers(body)).toEqual({ text: body, redacted: false, kinds: [] });
  });

  it("redacts an account number that follows a keyword", () => {
    const r = redactSensitiveNumbers("my account number is 000123456789 thanks");
    expect(r.text).toBe(`my account number is ${REDACTION_MARK} thanks`);
    expect(r.kinds).toEqual(["bank"]);
    expect(redactSensitiveNumbers("acct: 1234567").text).toBe(`acct: ${REDACTION_MARK}`);
    expect(redactSensitiveNumbers("routing 021000021").text).toBe(`routing ${REDACTION_MARK}`);
  });

  it("redacts a valid routing number sitting next to an account number", () => {
    const r = redactSensitiveNumbers("send to 021000021 and 123456789012 please");
    expect(r.text).toBe(`send to ${REDACTION_MARK} and ${REDACTION_MARK} please`);
    expect(r.kinds).toEqual(["bank"]);
  });

  it("leaves a lone 9-digit number alone", () => {
    expect(redactSensitiveNumbers("unit 021000021 is open").redacted).toBe(false);
  });

  it("handles empty and mixed bodies", () => {
    expect(redactSensitiveNumbers("")).toEqual({ text: "", redacted: false, kinds: [] });
    const r = redactSensitiveNumbers("card 4111 1111 1111 1111 and acct 998877665544");
    expect(r.text).toBe(`card ${REDACTION_MARK} and acct ${REDACTION_MARK}`);
    expect(r.kinds.sort()).toEqual(["bank", "card"]);
  });

  it("exposes the checksums and the canned reply", () => {
    expect(passesLuhn("4242424242424242")).toBe(true);
    expect(passesLuhn("4242424242424243")).toBe(false);
    expect(isValidAbaRouting("021000021")).toBe(true);
    expect(isValidAbaRouting("123456789")).toBe(false);
    expect(SECURE_PAYMENT_REPLY).toBe(
      "For your security, please do not text card or bank numbers. Use your secure payment link instead.",
    );
  });
});
