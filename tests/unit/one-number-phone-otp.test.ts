import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { hashOtpCode, normalizeOtpInput, otpMessageBody, requestPhoneOtp, verifyPhoneOtp } from "@/lib/one-number/phone-otp.server";
import { linksFakeDb } from "../helpers/links-fake-db";

const PHONE = "2065550100";
const HOUR = 60 * 60 * 1000;
const T0 = new Date("2026-10-18T12:00:00Z");

/** Request a code and capture what was "texted". */
async function request(db: never, over: { now?: Date; subjectId?: string | null; send?: (code: string) => Promise<boolean> } = {}) {
  let code = "";
  const result = await requestPhoneOtp(db, {
    phoneKey: PHONE,
    purpose: "link_unlock",
    subjectId: over.subjectId === undefined ? "link-1" : over.subjectId,
    now: over.now ?? T0,
    send: async (c) => {
      code = c;
      return over.send ? over.send(c) : true;
    },
  });
  return { result, code };
}

const verify = (db: never, code: unknown, now: Date = T0, subjectId: string | null = "link-1") =>
  verifyPhoneOtp(db, { phoneKey: PHONE, purpose: "link_unlock", subjectId, code, now });

describe("requestPhoneOtp", () => {
  it("sends a six-digit code and stores only a keyed hash bound to the challenge and phone", async () => {
    const { db, rows } = linksFakeDb();
    const { result, code } = await request(db);
    expect(result.ok).toBe(true);
    expect(code).toMatch(/^\d{6}$/);
    const row = rows.phone_otp_challenges![0]!;
    expect(JSON.stringify(rows)).not.toContain(`"${code}"`);
    expect(row.code_hash).toBe(hashOtpCode(String(row.id), PHONE, code));
    // Not a bare SHA-256 of the code (which a six-digit space would give up in a second).
    expect(row.code_hash).not.toBe(createHash("sha256").update(code).digest("hex"));
    expect(new Date(String(row.expires_at)).getTime()).toBe(T0.getTime() + 10 * 60 * 1000);
    expect(row.attempts).toBe(0);
  });

  it("allows 3 sends per phone per hour, then again once the hour passes", async () => {
    const { db } = linksFakeDb();
    for (let i = 0; i < 3; i += 1) expect((await request(db, { now: new Date(T0.getTime() + i * 1000) })).result.ok).toBe(true);
    expect((await request(db, { now: new Date(T0.getTime() + 5000) })).result).toEqual({ ok: false, reason: "rate_limited" });
    expect((await request(db, { now: new Date(T0.getTime() + HOUR + 10_000) })).result.ok).toBe(true);
  });

  it("the cap is per phone across subjects", async () => {
    const { db } = linksFakeDb();
    for (const subjectId of ["a", "b", "c"]) await request(db, { subjectId });
    expect((await request(db, { subjectId: "d" })).result).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("a text that never left leaves no challenge and spends no allowance", async () => {
    const { db, rows } = linksFakeDb();
    for (let i = 0; i < 5; i += 1) {
      expect((await request(db, { send: async () => false })).result).toEqual({ ok: false, reason: "send_failed" });
    }
    expect(rows.phone_otp_challenges).toHaveLength(0);
    expect((await request(db)).result.ok).toBe(true);
  });

  it("a thrown sender counts as not sent", async () => {
    const { db, rows } = linksFakeDb();
    const send = vi.fn(async () => { throw new Error("boom"); });
    expect((await request(db, { send })).result).toEqual({ ok: false, reason: "send_failed" });
    expect(rows.phone_otp_challenges).toHaveLength(0);
  });

  it("refuses a phone that is not ten digits and a database without the table", async () => {
    const { db } = linksFakeDb();
    expect(await requestPhoneOtp(db, { phoneKey: "555", purpose: "link_unlock", subjectId: "x", send: async () => true })).toEqual({ ok: false, reason: "unavailable" });
    const broken = linksFakeDb({}, { broken: ["phone_otp_challenges"] });
    expect((await request(broken.db)).result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("the message is one short GSM-7 text", () => {
    const body = otpMessageBody("123456");
    expect(body).toContain("123456");
    expect(body.length).toBeLessThanOrEqual(160);
    expect(/^[\x20-\x7e]+$/.test(body)).toBe(true);
    expect(body).not.toMatch(/[—–]/);
  });
});

describe("verifyPhoneOtp", () => {
  it("accepts the right code once", async () => {
    const { db } = linksFakeDb();
    const { code } = await request(db);
    expect(await verify(db, code)).toEqual({ ok: true });
    expect(await verify(db, code)).toEqual({ ok: false, reason: "no_challenge" });
  });

  it("expires after 10 minutes", async () => {
    const { db } = linksFakeDb();
    const { code } = await request(db);
    expect(await verify(db, code, new Date(T0.getTime() + 10 * 60 * 1000 + 1000))).toEqual({ ok: false, reason: "expired" });
    const second = linksFakeDb();
    const again = await request(second.db);
    expect(await verify(second.db, again.code, new Date(T0.getTime() + 9 * 60 * 1000 + 59_000))).toEqual({ ok: true });
  });

  it("locks after 5 wrong attempts, even for the right code", async () => {
    const { db, rows } = linksFakeDb();
    const { code } = await request(db);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i += 1) expect(await verify(db, wrong)).toEqual({ ok: false, reason: "wrong_code" });
    expect(rows.phone_otp_challenges![0]!.attempts).toBe(5);
    expect(await verify(db, code)).toEqual({ ok: false, reason: "locked" });
    expect(await verify(db, wrong)).toEqual({ ok: false, reason: "locked" });
  });

  it("locks the phone for 24 hours after 10 wrong codes in total, even for a fresh right code", async () => {
    const past = new Date(T0.getTime() - 60_000).toISOString();
    // Two earlier challenges whose five tries were all wrong: 10 lifetime failures.
    const { db, rows } = linksFakeDb({
      phone_otp_challenges: [0, 1].map((i) => ({ id: `old-${i}`, phone_key: PHONE, purpose: "link_unlock", subject_id: "other-link", attempts: 5, consumed_at: past, created_at: past })),
    });
    const { code } = await request(db, { now: new Date(T0.getTime() - 30_000) });
    expect(await verify(db, code)).toEqual({ ok: false, reason: "locked" });
    // No new text goes to a locked phone either.
    expect((await request(db, { now: new Date(T0.getTime() + HOUR + 10_000) })).result).toEqual({ ok: false, reason: "rate_limited" });
    // The failures age out after 24 hours.
    expect((await request(db, { now: new Date(T0.getTime() + 24 * HOUR + 10_000) })).result.ok).toBe(true);
  });

  it("a successful code is not counted as a failure toward the cap", async () => {
    const past = new Date(T0.getTime() - 60_000).toISOString();
    const { db } = linksFakeDb({
      phone_otp_challenges: Array.from({ length: 9 }, (_, i) => ({
        id: `ok-${i}`, phone_key: PHONE, purpose: "link_unlock", subject_id: "x", attempts: 1, verified_at: past, consumed_at: past, created_at: past,
      })),
    });
    const { code } = await request(db, { now: new Date(T0.getTime() + HOUR + 1000) });
    expect(await verify(db, code, new Date(T0.getTime() + HOUR + 2000))).toEqual({ ok: true });
  });

  it("the fifth try can still succeed", async () => {
    const { db } = linksFakeDb();
    const { code } = await request(db);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i += 1) await verify(db, wrong);
    expect(await verify(db, code)).toEqual({ ok: true });
  });

  it("a new code retires the old one", async () => {
    const { db } = linksFakeDb();
    const first = await request(db, { now: new Date(T0.getTime() + 1000) });
    const second = await request(db, { now: new Date(T0.getTime() + 2000) });
    if (first.code !== second.code) {
      expect(await verify(db, first.code, new Date(T0.getTime() + 3000))).toEqual({ ok: false, reason: "wrong_code" });
    }
    expect(await verify(db, second.code, new Date(T0.getTime() + 4000))).toEqual({ ok: true });
  });

  it("a code for one thing never opens another", async () => {
    const { db } = linksFakeDb();
    const { code } = await request(db, { subjectId: "link-1" });
    expect(await verify(db, code, T0, "link-2")).toEqual({ ok: false, reason: "no_challenge" });
    expect(await verifyPhoneOtp(db, { phoneKey: "2065550999", purpose: "link_unlock", subjectId: "link-1", code, now: T0 })).toEqual({ ok: false, reason: "no_challenge" });
    expect(await verifyPhoneOtp(db, { phoneKey: PHONE, purpose: "public_bind", subjectId: "link-1", code, now: T0 })).toEqual({ ok: false, reason: "no_challenge" });
  });

  it("concurrent guesses cannot get past the attempt counter", async () => {
    const { db, rows } = linksFakeDb();
    const { code } = await request(db);
    const wrong = code === "000000" ? "111111" : "000000";
    const results = await Promise.all(Array.from({ length: 12 }, () => verify(db, wrong)));
    // All read attempts = 0 at once; only one compare-and-set can take that slot.
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(rows.phone_otp_challenges![0]!.attempts).toBe(1);
  });

  it("a malformed code never matches", () => {
    expect(normalizeOtpInput("123456")).toBe("123456");
    expect(normalizeOtpInput("123 456")).toBe("123456");
    expect(normalizeOtpInput("12345")).toBeNull();
    expect(normalizeOtpInput("1234567")).toBeNull();
    expect(normalizeOtpInput("12345a")).toBeNull();
    expect(normalizeOtpInput(null)).toBeNull();
    expect(normalizeOtpInput({})).toBeNull();
  });

  it("reads a database without the table as no challenge", async () => {
    const { db } = linksFakeDb({}, { broken: ["phone_otp_challenges"] });
    expect(await verify(db, "123456")).toEqual({ ok: false, reason: "no_challenge" });
  });
});

describe("the failed-code cap is scoped to its PURPOSE", () => {
  /** /api/public/phone-bind lets anyone holding a printed entry code name an arbitrary phone and guess at it. */
  const bindSend = (db: never, now: Date) =>
    requestPhoneOtp(db, { phoneKey: PHONE, purpose: "public_bind", subjectId: "entry-1", now, send: async () => true });
  const bindVerify = (db: never, now: Date) =>
    verifyPhoneOtp(db, { phoneKey: PHONE, purpose: "public_bind", subjectId: "entry-1", code: "000000", now });

  /** Two sends plus five wrong codes each: the ten failures the 24-hour cap counts. */
  async function burnPublicBindBudget(db: never) {
    for (const offset of [0, 1000]) {
      await bindSend(db, new Date(T0.getTime() + offset));
      for (let i = 0; i < 5; i += 1) await bindVerify(db, new Date(T0.getTime() + offset + 100 + i));
    }
  }

  it("locks the purpose that was actually guessed at", async () => {
    const { db } = linksFakeDb();
    await burnPublicBindBudget(db);
    const later = new Date(T0.getTime() + 2 * HOUR);
    expect((await bindVerify(db, later)).reason).toBe("locked");
    expect(await bindSend(db, later)).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("never locks the owner out of their rent link or texts them for it", async () => {
    const { db } = linksFakeDb();
    await burnPublicBindBudget(db);
    // The victim's own purpose is untouched: a code still goes out, and it still verifies.
    const later = new Date(T0.getTime() + 2 * HOUR);
    const { result, code } = await request(db, { now: later });
    expect(result.ok).toBe(true);
    expect(await verify(db, code, new Date(later.getTime() + 1000))).toEqual({ ok: true });
  });
});
