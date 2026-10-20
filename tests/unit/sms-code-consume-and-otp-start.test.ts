// Review fixes, Oct 20. Two one-time-code paths that were check-then-act:
//  - `checkSmsConfirmationCode` discarded the consume write's result, and PostgREST reports a failed write as a
//    resolved `{ error }` - so a failed consume left `consumed_at` null and the SAME code kept verifying for the
//    rest of its 30-minute life, confirming a texted invoice approval or a stay booking twice;
//  - `requestPhoneOtp` counted the hour's sends, retired older codes and inserted as three separate round trips,
//    so two concurrent sends both passed the 3-per-hour cap and could leave two live codes behind.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createFakeDb } from "../helpers/fake-table-db";
import { withSmsConfirmationReserveRpc as withReserveRpc } from "../helpers/sms-confirmation-rpc";
import { checkSmsConfirmationCode, issueSmsConfirmationCode } from "@/lib/sms/confirmation-code";
import { PHONE_LIFETIME_FAILED_CODE_CAP, requestPhoneOtp } from "@/lib/one-number/phone-otp.server";
import { SHARED_LINE_OTP_RULES } from "@/lib/one-number/contracts";
import { phoneKeyOf, phoneRateKey, safeEqualHex } from "@/lib/sms/phone-key";

const subject = { kind: "pending_action" as const, subjectId: "action-1" };

beforeEach(() => {
  vi.stubEnv("PHONE_OTP_HMAC_SECRET", "");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
});

describe("the confirmation code's consume is the gate", () => {
  it("a correct code works exactly once", async () => {
    const f = withReserveRpc(createFakeDb({ sms_confirmation_codes: [] }));
    const code = await issueSmsConfirmationCode(f as never, subject);
    expect(await checkSmsConfirmationCode(f as never, { ...subject, code: code! })).toBe("ok");
    expect(f.tables.sms_confirmation_codes![0]!.consumed_at).toBeTruthy();
    // The replay: same code, same subject, nothing re-issued.
    expect(await checkSmsConfirmationCode(f as never, { ...subject, code: code! })).toBe("wrong");
  });

  it("refuses rather than confirming when the consume write fails", async () => {
    const codes: Array<Record<string, unknown>> = [];
    let consumes = 0;
    const f = withReserveRpc(
      createFakeDb(
        { sms_confirmation_codes: codes },
        {
          failWrite: (table, mode, payload) => {
            // Only the consume (the update that sets `consumed_at`), never the attempt count.
            if (table === "sms_confirmation_codes" && mode === "update" && payload && "consumed_at" in payload) {
              consumes += 1;
              return { code: "57014", message: "statement timeout" };
            }
            return null;
          },
        },
      ),
    );
    const code = await issueSmsConfirmationCode(f as never, subject);
    expect(await checkSmsConfirmationCode(f as never, { ...subject, code: code! })).toBe("unavailable");
    expect(consumes).toBe(1);
    // Nothing was confirmed, so the caller re-asks; it must never have read as `ok`.
    expect(f.tables.sms_confirmation_codes![0]!.consumed_at ?? null).toBeNull();
  });

  it("a right answer still costs the phone no guess", async () => {
    const f = withReserveRpc(createFakeDb({ sms_confirmation_codes: [], sms_confirmation_failures: [] }));
    const code = await issueSmsConfirmationCode(f as never, subject);
    expect(await checkSmsConfirmationCode(f as never, { ...subject, code: code!, phone: "+12065550142" })).toBe("ok");
    expect(f.tables.sms_confirmation_failures).toHaveLength(0);
  });
});

describe("requestPhoneOtp claims the hour's allowance in one statement", () => {
  function rpcDb(answer: (args: Record<string, unknown>) => { data: unknown; error: unknown }) {
    const calls: Array<Record<string, unknown>> = [];
    const db = createFakeDb({ phone_otp_challenges: [] });
    return {
      calls,
      db: Object.assign(db, {
        rpc: async (name: string, args: Record<string, unknown>) => {
          calls.push({ name, ...args });
          return name === "phone_otp_start" ? answer(args) : { data: null, error: { message: "unknown function" } };
        },
      }),
    };
  }

  it("asks `phone_otp_start`, and does not write the challenge itself", async () => {
    const { calls, db } = rpcDb(() => ({ data: true, error: null }));
    const sent: string[] = [];
    const result = await requestPhoneOtp(db as never, {
      phoneKey: "2065550142",
      purpose: "link_unlock",
      subjectId: "link-1",
      send: async (code) => (sent.push(code), true),
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "phone_otp_start",
      p_phone_key: "2065550142",
      p_purpose: "link_unlock",
      p_subject: "link-1",
      p_ttl_minutes: SHARED_LINE_OTP_RULES.ttlMinutes,
    });
    // The code goes out, but never into the function's arguments: only its hash does.
    expect(sent[0]).toMatch(/^\d{6}$/);
    expect(String(calls[0]!.p_code_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(calls[0])).not.toContain(sent[0]!);
    // No second, racing write path.
    expect(db.tables.phone_otp_challenges).toHaveLength(0);
  });

  // Review fix, Oct 20: the caps were a second copy inside the function, so editing the constant would have left
  // the enforced limit where it was. They travel as arguments now - one source of truth.
  it("passes every cap from SHARED_LINE_OTP_RULES rather than letting SQL keep its own copy", async () => {
    const { calls, db } = rpcDb(() => ({ data: true, error: null }));
    await requestPhoneOtp(db as never, {
      phoneKey: "2065550142",
      purpose: "link_unlock",
      subjectId: "link-1",
      send: async () => true,
    });
    expect(calls[0]).toMatchObject({
      p_max_per_purpose: SHARED_LINE_OTP_RULES.maxSendsPerHour,
      p_max_per_phone: SHARED_LINE_OTP_RULES.maxSendsPerPhonePerHour,
      p_max_failed: PHONE_LIFETIME_FAILED_CODE_CAP,
      p_ttl_minutes: SHARED_LINE_OTP_RULES.ttlMinutes,
    });
  });

  it("reports the function's refusal as rate limited, and never texts", async () => {
    const { db } = rpcDb(() => ({ data: false, error: null }));
    let texted = false;
    const result = await requestPhoneOtp(db as never, {
      phoneKey: "2065550142",
      purpose: "link_unlock",
      subjectId: "link-1",
      send: async () => ((texted = true), true),
    });
    expect(result).toEqual({ ok: false, reason: "rate_limited" });
    expect(texted).toBe(false);
  });

  it("a failed read is unavailable, not a free code", async () => {
    const { db } = rpcDb(() => ({ data: null, error: { code: "57014", message: "statement timeout" } }));
    const result = await requestPhoneOtp(db as never, {
      phoneKey: "2065550142",
      purpose: "link_unlock",
      subjectId: "link-1",
      send: async () => true,
    });
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("keeps working on a database where the function is not there yet", async () => {
    const { db } = rpcDb(() => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }));
    const result = await requestPhoneOtp(db as never, {
      phoneKey: "2065550142",
      purpose: "link_unlock",
      subjectId: "link-1",
      send: async () => true,
    });
    expect(result.ok).toBe(true);
    expect(db.tables.phone_otp_challenges).toHaveLength(1);
  });
});

// Review fix, Oct 20 (simplification): `safeEqualHex`, the "sha256 hex slice(0,32) as a rate key" helper and
// `phoneKeyOf` had each grown several copies across `one-number/` and `sms/`. All three are security-relevant - a
// storage key, a rate-limit bucket and a constant-time compare - and a second copy of a constant-time compare is
// exactly what drifts into `===` in one file and nowhere else. They live in one module now.
describe("the shared phone-key helpers", () => {
  it("phoneKeyOf is the last ten digits, whatever shape the number arrives in", () => {
    for (const input of ["+12065550142", "(206) 555-0142", "206-555-0142", "12065550142"]) {
      expect(phoneKeyOf(input)).toBe("2065550142");
    }
    expect(phoneKeyOf("")).toBe("");
  });

  it("phoneRateKey is a 32-char hex digest that never contains the number", () => {
    const key = phoneRateKey("2065550142");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toContain("2065550142");
    expect(phoneRateKey("2065550142")).toBe(key);
    expect(phoneRateKey("2065550143")).not.toBe(key);
  });

  it("safeEqualHex matches only equal digests, and never throws on a length mismatch", () => {
    expect(safeEqualHex("abcd", "abcd")).toBe(true);
    expect(safeEqualHex("abcd", "abce")).toBe(false);
    expect(safeEqualHex("abcd", "abcdef")).toBe(false);
    expect(safeEqualHex("", "")).toBe(true);
  });
});
