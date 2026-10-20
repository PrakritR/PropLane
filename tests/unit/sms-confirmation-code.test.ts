/**
 * A write confirmed from a manager phone on the PropLane line needs the 4-digit code shown in its own ask.
 *
 * Identity on that line is a spoofable caller ID, so a bare YES must not be an authorization: the code travels only
 * in the ask, which went to the real phone. The code is random per proposal and only its hash is stored, and three
 * wrong codes cancel the proposal - a 4-digit secret with no lockout is a 13-bit PIN a spoofer could walk through.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createFakeDb } from "../helpers/fake-table-db";
import {
  checkSmsConfirmationCode,
  clearSmsConfirmationCode,
  codedConfirmationLine,
  issueSmsConfirmationCode,
  readSmsConfirmationCode,
  smsConfirmationCodeConfigured,
  withConfirmationCode,
  SMS_CONFIRMATION_CODE_MAX_ATTEMPTS,
} from "@/lib/sms/confirmation-code";

const subject = { kind: "pending_action" as const, subjectId: "action-1" };
const other = { kind: "pending_action" as const, subjectId: "action-2" };
const db = () => createFakeDb({ sms_confirmation_codes: [] });

beforeEach(() => {
  vi.stubEnv("PHONE_OTP_HMAC_SECRET", "");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
});

describe("issuing a code", () => {
  it("is four digits, random per proposal, and stores only its hash", async () => {
    const f = db();
    const code = await issueSmsConfirmationCode(f as never, subject);
    expect(code).toMatch(/^\d{4}$/);
    const row = f.tables.sms_confirmation_codes![0]!;
    expect(row).toMatchObject({ subject_kind: "pending_action", subject_id: "action-1", attempts: 0 });
    expect(JSON.stringify(row)).not.toContain(code!);
    expect(String(row.code_hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("re-issuing replaces the code but never the attempt count", async () => {
    const f = db();
    const first = await issueSmsConfirmationCode(f as never, subject);
    await checkSmsConfirmationCode(f as never, { ...subject, code: "0000" === first ? "1111" : "0000" });
    expect(f.tables.sms_confirmation_codes![0]!.attempts).toBe(1);
    const second = await issueSmsConfirmationCode(f as never, subject);
    expect(second).not.toBe(first);
    expect(f.tables.sms_confirmation_codes![0]!.attempts).toBe(1);
    // The old code is dead the moment a new one is issued.
    expect(await checkSmsConfirmationCode(f as never, { ...subject, code: first! })).toBe("wrong");
    expect(await checkSmsConfirmationCode(f as never, { ...subject, code: second! })).toBe("ok");
  });

  it("fails closed with no signing key: no code, and no coded confirmation", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("PHONE_OTP_HMAC_SECRET", "");
    expect(smsConfirmationCodeConfigured()).toBe(false);
    const f = db();
    expect(await issueSmsConfirmationCode(f as never, subject)).toBeNull();
    expect(await checkSmsConfirmationCode(f as never, { ...subject, code: "1234" })).toBe("unavailable");
  });
});

describe("the attempt budget belongs to one proposal", () => {
  const invoice = { kind: "dispatch_invoice" as const, subjectId: "run-1" };
  const burn = async (f: ReturnType<typeof db>, code: string) => {
    const wrong = code === "0000" ? "1111" : "0000";
    const outcomes: string[] = [];
    for (let i = 0; i < SMS_CONFIRMATION_CODE_MAX_ATTEMPTS; i += 1) {
      outcomes.push(await checkSmsConfirmationCode(f as never, { ...invoice, code: wrong }));
    }
    return outcomes;
  };

  it("a NEW proposal on the same subject gets a fresh budget; a re-ask of the open one does not", async () => {
    const f = db();
    // A dispatch run raises proposals in succession (a second texted invoice). Keyed on the run alone, the first
    // proposal's three wrong codes left every later one pre-exhausted - and auto-declined on the first reply.
    const first = await issueSmsConfirmationCode(f as never, { ...invoice, proposalId: "invoice:att-1:35000" });
    expect(await burn(f, first!)).toEqual(["wrong", "wrong", "exhausted"]);

    // Re-asking the SAME proposal (no proposalId) must not hand the guesser a fresh budget.
    const reask = await issueSmsConfirmationCode(f as never, invoice);
    expect(await checkSmsConfirmationCode(f as never, { ...invoice, code: reask! })).toBe("exhausted");

    // The vendor texts a new invoice: a new proposal, a new budget, and the manager can answer it.
    const second = await issueSmsConfirmationCode(f as never, { ...invoice, proposalId: "invoice:att-2:35000" });
    expect(f.tables.sms_confirmation_codes![0]!.attempts).toBe(0);
    expect(await checkSmsConfirmationCode(f as never, { ...invoice, code: second! })).toBe("ok");
  });

  it("the cancelled proposal's row is dropped, so the same proposal coming round again starts clean", async () => {
    const f = db();
    // A proposal id is built from the proposal's own facts (the attempt and the amount), so a vendor re-texting the
    // invoice the manager never confirmed raises a proposal with the SAME id. Keeping the cancelled row would hand
    // that one three spent guesses and auto-decline it on the first answer.
    const proposalId = "invoice:att-1:35000";
    const code = await issueSmsConfirmationCode(f as never, { ...invoice, proposalId });
    expect(await burn(f, code!)).toEqual(["wrong", "wrong", "exhausted"]);
    await clearSmsConfirmationCode(f as never, invoice);
    expect(f.tables.sms_confirmation_codes).toEqual([]);

    const again = await issueSmsConfirmationCode(f as never, { ...invoice, proposalId });
    expect(await checkSmsConfirmationCode(f as never, { ...invoice, code: again! })).toBe("ok");
  });
});

describe("checking a code", () => {
  it("accepts the exact code once, and a code for another proposal never works", async () => {
    const f = db();
    const code = await issueSmsConfirmationCode(f as never, subject);
    const otherCode = await issueSmsConfirmationCode(f as never, other);
    expect(await checkSmsConfirmationCode(f as never, { ...subject, code: otherCode! })).not.toBe("ok");
    expect(await checkSmsConfirmationCode(f as never, { ...subject, code: code! })).toBe("ok");
    // Single use: the same code cannot confirm twice.
    expect(await checkSmsConfirmationCode(f as never, { ...subject, code: code! })).toBe("wrong");
  });

  it("the third wrong code is exhausted, and the right code no longer works after it", async () => {
    const f = db();
    const code = await issueSmsConfirmationCode(f as never, subject);
    const wrong = code === "0000" ? "1111" : "0000";
    const outcomes: string[] = [];
    for (let i = 0; i < SMS_CONFIRMATION_CODE_MAX_ATTEMPTS; i += 1) {
      outcomes.push(await checkSmsConfirmationCode(f as never, { ...subject, code: wrong }));
    }
    expect(outcomes).toEqual(["wrong", "wrong", "exhausted"]);
    expect(await checkSmsConfirmationCode(f as never, { ...subject, code: code! })).toBe("exhausted");
  });

  it("an expired code is re-asked rather than charged an attempt", async () => {
    const f = db();
    await issueSmsConfirmationCode(f as never, subject);
    f.tables.sms_confirmation_codes![0]!.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await checkSmsConfirmationCode(f as never, { ...subject, code: "1234" })).toBe("wrong");
    expect(f.tables.sms_confirmation_codes![0]!.attempts ?? 0).toBe(0);
  });

  it("nothing issued is wrong, not confirmed", async () => {
    expect(await checkSmsConfirmationCode(db() as never, { ...subject, code: "1234" })).toBe("wrong");
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
    expect(withConfirmationCode(preview, "4821")).toBe(`Charge Dana $1,200\n\n${codedConfirmationLine("4821")}`);
    expect(withConfirmationCode(preview, "4821")).toContain("Reply YES 4821");
    expect(withConfirmationCode(preview, "4821")).not.toContain("Reply YES to confirm");
  });

  it("appends the instruction when the preview has none", () => {
    expect(withConfirmationCode("Charge Dana $1,200", "4821")).toContain(codedConfirmationLine("4821"));
  });
});
