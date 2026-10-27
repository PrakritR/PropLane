// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { formatPhoneInput, phoneDisplayLabel, phoneNationalDigits, phoneSubmitValue } from "@/lib/phone-format";
import { codeDigitsFrom, formatCountdown } from "@/lib/auth/phone-code-input";
import { REMEMBERED_LOGIN_PHONE_KEY, readLastLoginMethod, readRememberedLoginPhone, rememberLoginMethod, rememberLoginPhone } from "@/lib/auth/remembered-login";

describe("as-you-type US phone formatting (fixed +1 prefix)", () => {
  it.each([
    ["", ""], ["5", "(5"], ["510", "(510"], ["5103", "(510) 3"], ["510309", "(510) 309"], ["5103098", "(510) 309-8"], ["5103098345", "(510) 309-8345"],
    ["51030983456789", "(510) 309-8345"],
  ])("types %j as %j", (typed, shown) => expect(formatPhoneInput(typed)).toBe(shown));

  it.each([
    "+1 510-309-8345", "+15103098345", "15103098345", "1 (510) 309 8345", "510.309.8345", " (510) 309-8345 ", "+1 (510) 309-8345",
  ])("pastes %j in any format", (pasted) => {
    expect(formatPhoneInput(pasted)).toBe("(510) 309-8345");
    expect(phoneSubmitValue(formatPhoneInput(pasted))).toBe("+15103098345");
  });

  it("types a leading country 1 away, since +1 is already on screen", () => {
    expect(phoneNationalDigits("1")).toBe("");
    expect(formatPhoneInput("1510")).toBe("(510");
  });

  it("backspacing through the number never leaves trailing punctuation behind", () => {
    expect(["(510) 309-8345", "(510) 309-834", "(510) 309-83", "(510) 309-8", "(510) 309", "(510) 30", "(510) 3", "(510", "(51", "("].map((value, index, all) =>
      formatPhoneInput(index === 0 ? value : all[index])).every((shown, index, all) => shown === all[index])).toBe(true);
    expect(formatPhoneInput("(510) ")).toBe("(510");
    expect(formatPhoneInput("(510) 309-")).toBe("(510) 309");
    expect(formatPhoneInput("(")).toBe("");
  });

  it("a non-US international paste is left alone so the server can say `US and Canada only`", () => {
    expect(formatPhoneInput("+44 20 7946 0958")).toBe("+44 20 7946 0958");
    expect(phoneSubmitValue("+44 20 7946 0958")).toBe("+44 20 7946 0958");
  });

  it("sends a short number as typed digits (the server answers `Enter a 10-digit phone number`), a full one as +1", () => {
    expect(phoneSubmitValue("(510) 309")).toBe("510309");
    expect(phoneSubmitValue("")).toBe("");
    expect(phoneSubmitValue("(425) 555-0123")).toBe("+14255550123");
  });

  it("labels the number the code was sent to", () => {
    expect(phoneDisplayLabel("+15103098345")).toBe("(510) 309-8345");
    expect(phoneDisplayLabel("(510) 309-8345")).toBe("(510) 309-8345");
  });
});

describe("code field helpers", () => {
  it.each([["482913", "482913"], ["482 913", "482913"], ["12", "12"], ["4829131", "482913"], ["", ""]])("digits from %j", (raw, digits) => expect(codeDigitsFrom(raw)).toBe(digits));
  it("pulls the code out of a pasted text message", () => {
    expect(codeDigitsFrom("Your PropLane code is 482913. It expires in 10 minutes. Do not share this code.\n\n@proplane.ai #482913")).toBe("482913");
  });
  it("counts down as m:ss", () => {
    expect([30, 9, 0, 65, -1].map(formatCountdown)).toEqual(["0:30", "0:09", "0:00", "1:05", "0:00"]);
  });
});

describe("remembered login (device memory)", () => {
  it("stores the last phone and method under axis: keys so the portal cache clear removes them with the email", () => {
    expect(REMEMBERED_LOGIN_PHONE_KEY).toBe("axis:remembered-login-phone");
    window.localStorage.clear();
    rememberLoginPhone("(510) 309-8345");
    rememberLoginMethod("phone");
    expect(readRememberedLoginPhone()).toBe("(510) 309-8345");
    expect(readLastLoginMethod()).toBe("phone");
    expect(/^(axis[:_]|propplane\.|proplane[_.:])/i.test(REMEMBERED_LOGIN_PHONE_KEY)).toBe(true);
  });

  it("falls back to whichever single credential this device remembers, and survives blocked storage", () => {
    window.localStorage.clear();
    expect(readLastLoginMethod()).toBeNull();
    window.localStorage.setItem("axis:remembered-login-email", "a@b.test");
    expect(readLastLoginMethod()).toBe("email");
    const original = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    try {
      expect(readRememberedLoginPhone()).toBe("");
      expect(readLastLoginMethod()).toBeNull();
      expect(() => rememberLoginPhone("x")).not.toThrow();
    } finally {
      Object.defineProperty(window, "localStorage", original);
    }
  });
});
