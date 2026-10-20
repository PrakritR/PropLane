/**
 * A write confirmed from a manager phone on the PropLane line needs the 4-digit code shown in its own preview
 * ("Reply YES 4821"). Identity on that line is a spoofable caller ID, and the service manager phone reaches every
 * PropLane Service workspace, so a bare YES must not be an authorization: the code travels only in the preview,
 * which went to the real phone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  codedConfirmationLine,
  readSmsConfirmationCode,
  smsConfirmationCode,
  smsConfirmationCodeMatches,
  withConfirmationCode,
} from "@/lib/sms/confirmation-code";

beforeEach(() => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
});

describe("the code", () => {
  it("is four digits, stable for one proposal and different for another", () => {
    const a = smsConfirmationCode("action-1");
    expect(a).toMatch(/^\d{4}$/);
    expect(smsConfirmationCode("action-1")).toBe(a);
    expect(smsConfirmationCode("action-2")).not.toBe(a);
  });

  it("is derived from a server secret, so it cannot be computed from the action id alone", () => {
    const a = smsConfirmationCode("action-1");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "a-different-key");
    expect(smsConfirmationCode("action-1")).not.toBe(a);
  });

  it("matches only the exact code", () => {
    const code = smsConfirmationCode("action-1");
    expect(smsConfirmationCodeMatches("action-1", code)).toBe(true);
    expect(smsConfirmationCodeMatches("action-1", ` ${code} `)).toBe(true);
    expect(smsConfirmationCodeMatches("action-1", smsConfirmationCode("action-2"))).toBe(false);
    expect(smsConfirmationCodeMatches("action-1", null)).toBe(false);
    expect(smsConfirmationCodeMatches("action-1", "")).toBe(false);
    expect(smsConfirmationCodeMatches("action-1", code.slice(0, 3))).toBe(false);
  });
});

describe("reading the reply", () => {
  it("takes the code from an affirmative reply, in any of its words", () => {
    expect(readSmsConfirmationCode("YES 4821")).toBe("4821");
    expect(readSmsConfirmationCode("yes 4821.")).toBe("4821");
    expect(readSmsConfirmationCode("Y 0007")).toBe("0007");
    expect(readSmsConfirmationCode("confirm 1234")).toBe("1234");
  });

  it("a bare YES, a bare number, a NO or a sentence carries no code", () => {
    expect(readSmsConfirmationCode("YES")).toBeNull();
    expect(readSmsConfirmationCode("4821")).toBeNull();
    expect(readSmsConfirmationCode("NO 4821")).toBeNull();
    expect(readSmsConfirmationCode("yes please 4821")).toBeNull();
    expect(readSmsConfirmationCode("")).toBeNull();
  });
});

describe("the preview", () => {
  it("replaces the plain instruction with the coded one", () => {
    const preview = "Charge Dana $1,200\n\nReply YES to confirm or NO to cancel.";
    const coded = withConfirmationCode(preview, "action-1");
    expect(coded).toBe(`Charge Dana $1,200\n\n${codedConfirmationLine("action-1")}`);
    expect(coded).toContain(`Reply YES ${smsConfirmationCode("action-1")}`);
    expect(coded).not.toContain("Reply YES to confirm");
  });

  it("appends the instruction when the preview has none", () => {
    expect(withConfirmationCode("Charge Dana $1,200", "action-1")).toContain(codedConfirmationLine("action-1"));
  });
});
