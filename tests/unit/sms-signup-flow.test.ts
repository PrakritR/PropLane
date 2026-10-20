// Sign-up by text: the conversation, the code-echo proof (wrong code, expired, retries capped), no duplicate account for a
// phone that already has one, and what is handed to provisioning.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { linksFakeDb } from "../helpers/links-fake-db";

vi.mock("server-only", () => ({}));
const rate = vi.hoisted(() => ({ ok: true }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: rate.ok })), clientIpFrom: () => "1.1.1.1" }));
vi.mock("@/lib/auth/phone-auth.server", () => ({ phoneOwners: vi.fn(async () => []) }));
vi.mock("@/lib/one-number/signup/provision.server", () => ({ provisionSmsSignupAccount: vi.fn() }));
vi.mock("@/lib/one-number/signup/sign-in-link.server", () => ({ mintPhoneSignInLink: vi.fn(async () => null) }));

import { handleSmsSignupText, SIGNUP_COPY, type SignupDeps } from "@/lib/one-number/signup/flow.server";
import type { SmsSignupInput, SmsSignupResult } from "@/lib/one-number/signup/provision.server";

const PHONE = "+12065550142";
const KEY = "2065550142";
const T0 = new Date("2026-10-19T20:00:00Z");

type World = ReturnType<typeof world>;
function world(over: Partial<SignupDeps> = {}) {
  const f = linksFakeDb();
  const state = { now: T0, sid: 0, owners: [] as string[] };
  const provisioned: SmsSignupInput[] = [];
  const deps: SignupDeps = {
    now: () => state.now,
    origin: "https://proplane.ai",
    findOwners: async () => state.owners,
    provision: async (_db, input): Promise<SmsSignupResult> => {
      provisioned.push(input);
      return { ok: true, userId: "user-1", email: "x@phone.proplane.invalid" };
    },
    signInLink: async () => "https://proplane.ai/auth/confirm?token_hash=HASH&type=magiclink",
    webLink: async (_db, { role }) => (role === "resident" ? null : `https://proplane.ai/start/WEBTOKEN-${role}`),
    ...over,
  };
  const say = async (body: string, opts: { phone?: string; sid?: string } = {}) => {
    state.sid += 1;
    const turn = await handleSmsSignupText(f.db, { phoneE164: opts.phone ?? PHONE, body, messageSid: opts.sid ?? `SM${state.sid}` }, deps);
    return turn.handled ? turn.reply : null;
  };
  return { f, state, deps, provisioned, say };
}

const codeIn = (reply: string | null): string => /code: (\d{6})/.exec(reply ?? "")?.[1] ?? "";

async function toCodeStep(w: World) {
  expect(await w.say("Hey I want to sign up as a manager")).toContain("full name");
  await w.say("Jane Doe");
  await w.say("Doe Rentals");
  await w.say("12");
  const reply = await w.say("jane@doerentals.com");
  return codeIn(reply);
}

beforeEach(() => {
  rate.ok = true;
});

describe("the manager conversation, one question per text", () => {
  it("runs the whole transcript and creates the account only after the code comes back", async () => {
    const w = world();
    const transcript: string[] = [];
    const turn = async (body: string) => {
      const reply = await w.say(body);
      transcript.push(`> ${body}\n< ${reply}`);
      return reply;
    };
    const r1 = await turn("Hey I want to sign up as a manager");
    expect(r1).toContain("property manager account");
    expect(r1).toContain("What is your full name?");
    expect(r1).toContain("https://proplane.ai/start/WEBTOKEN-manager");
    expect(r1).toContain("STOP");
    expect(r1).not.toContain("/demo");
    const r2 = await turn("Jane Doe");
    expect(r2).toBe("Thanks, Jane. What is your business or workspace name? Reply SKIP to decide later.");
    const r3 = await turn("Doe Rentals");
    expect(r3).toBe(SIGNUP_COPY.askHomes);
    const r4 = await turn("12");
    expect(r4).toBe(SIGNUP_COPY.askEmail);
    expect(w.provisioned).toHaveLength(0);
    const r5 = await turn("jane@doerentals.com");
    const code = codeIn(r5);
    expect(code).toMatch(/^\d{6}$/);
    expect(r5).toContain("reply with this code");
    // Nothing is created on the strength of the caller id alone.
    expect(w.provisioned).toHaveLength(0);
    const r6 = await turn(code);
    expect(r6).toBe("You're set, Jane. Your PropLane account is ready. Manage everything right here by text, or open your portal: https://proplane.ai/auth/confirm?token_hash=HASH&type=magiclink");
    expect(w.provisioned).toHaveLength(1);
    expect(w.provisioned[0]).toMatchObject({
      phoneE164: PHONE,
      role: "manager",
      answers: { fullName: "Jane Doe", businessName: "Doe Rentals", homes: 12, email: "jane@doerentals.com" },
    });
    // The typed answers are dropped once the account exists.
    expect(w.f.rows.sms_signup_sessions![0]).toMatchObject({ step: "done", user_id: "user-1", answers: { source: "explicit" } });
    expect(JSON.stringify(w.f.rows.sms_signup_sessions)).not.toContain("jane@doerentals.com");
    expect(transcript.join("\n")).not.toMatch(/—|–/);
  });

  it("SKIP is allowed for the business name and the email", async () => {
    const w = world();
    await w.say("sign me up as a landlord");
    await w.say("Jane Doe");
    await w.say("skip");
    await w.say("0");
    const reply = await w.say("SKIP");
    const code = codeIn(reply);
    await w.say(code);
    expect(w.provisioned[0]!.answers).toMatchObject({ fullName: "Jane Doe", homes: 0 });
    expect(w.provisioned[0]!.answers.businessName).toBeUndefined();
    expect(w.provisioned[0]!.answers.email).toBeUndefined();
  });

  it("a bad answer re-asks the same question and does not advance", async () => {
    const w = world();
    await w.say("I want to sign up as a manager");
    expect(await w.say("what is this?")).toBe(SIGNUP_COPY.retryName);
    await w.say("Jane Doe");
    await w.say("Doe Rentals");
    expect(await w.say("lots")).toBe(SIGNUP_COPY.retryHomes);
    expect(await w.say("7")).toBe(SIGNUP_COPY.askEmail);
    expect(await w.say("not an email")).toBe(SIGNUP_COPY.retryEmail);
  });

  it("asks the role once when the words do not say, then carries on", async () => {
    const w = world();
    expect(await w.say("SIGNUP")).toContain("property manager, a vendor, or a resident");
    expect(await w.say("banana")).toBe(SIGNUP_COPY.retryRole);
    const reply = await w.say("1");
    expect(reply).toContain("property manager account");
    expect(reply).toContain("WEBTOKEN-manager");
    expect(w.f.rows.sms_signup_sessions![0]).toMatchObject({ role: "manager", step: "name" });
  });

  it("every reply is one GSM-7 body: no long dashes, no curly quotes", async () => {
    const w = world();
    const replies = [await w.say("I want to sign up as a manager"), await w.say("Jane Doe"), await w.say("Doe Rentals"), await w.say("12"), await w.say("SKIP")];
    for (const reply of replies) expect(reply).toMatch(/^[\x20-\x7E\n]+$/);
  });
});

describe("the code echo is the proof of the phone", () => {
  it("a wrong code is refused, then the right one works", async () => {
    const w = world();
    const code = await toCodeStep(w);
    const wrong = code === "000000" ? "111111" : "000000";
    expect(await w.say(wrong)).toBe(SIGNUP_COPY.wrongCode);
    expect(w.provisioned).toHaveLength(0);
    expect(await w.say(code)).toContain("You're set, Jane");
    expect(w.provisioned).toHaveLength(1);
  });

  it("an expired code is refused and a new one can be requested with CODE", async () => {
    const w = world();
    const code = await toCodeStep(w);
    w.state.now = new Date(T0.getTime() + 11 * 60 * 1000);
    expect(await w.say(code)).toBe(SIGNUP_COPY.expiredCode);
    expect(w.provisioned).toHaveLength(0);
    const fresh = codeIn(await w.say("CODE"));
    expect(fresh).toMatch(/^\d{6}$/);
    expect(fresh).not.toBe(code);
    expect(await w.say(fresh)).toContain("You're set");
    // The first code never works again.
    expect(w.provisioned).toHaveLength(1);
  });

  it("retries are capped: five wrong guesses lock the code, even for the right one", async () => {
    const w = world();
    const code = await toCodeStep(w);
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i += 1) expect(await w.say(wrong)).toBe(SIGNUP_COPY.wrongCode);
    expect(await w.say(code)).toBe(SIGNUP_COPY.lockedCode);
    expect(w.provisioned).toHaveLength(0);
  });

  it("a new code replaces the old: only the newest works", async () => {
    const w = world();
    const first = await toCodeStep(w);
    const second = codeIn(await w.say("resend"));
    expect(second).not.toBe(first);
    expect(await w.say(first)).toBe(SIGNUP_COPY.wrongCode);
    expect(await w.say(second)).toContain("You're set");
  });

  it("the code is only ever in the reply to the number that asked, and only its hash is stored", async () => {
    const w = world();
    const code = await toCodeStep(w);
    const challenges = w.f.rows.phone_otp_challenges!;
    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toMatchObject({ phone_key: KEY, purpose: "sms_signup" });
    expect(JSON.stringify(w.f.rows)).not.toContain(`"${code}"`);
  });

  it("a code issued to one phone never verifies another phone", async () => {
    const w = world();
    const code = await toCodeStep(w);
    const other = "+12065550177";
    await w.say("sign me up as a manager", { phone: other });
    for (const text of ["Sam Roe", "SKIP", "SKIP", "SKIP"]) await w.say(text, { phone: other });
    expect(await w.say(code, { phone: other })).toBe(SIGNUP_COPY.wrongCode);
    expect(w.provisioned).toHaveLength(0);
  });

  it("a non-code reply at the code step asks for the code again and creates nothing", async () => {
    const w = world();
    await toCodeStep(w);
    expect(await w.say("hello?")).toBe(SIGNUP_COPY.needCode);
    expect(w.provisioned).toHaveLength(0);
  });

  it("at most three codes per phone per hour: the fourth is a polite wait", async () => {
    const w = world();
    await toCodeStep(w);
    await w.say("CODE");
    await w.say("CODE");
    expect(await w.say("CODE")).toBe(SIGNUP_COPY.rateLimitedCode);
  });
});

describe("one account per phone", () => {
  it("a phone that already has an account gets a sign-in link, not a second account, and no conversation", async () => {
    const w = world();
    w.state.owners = ["existing-user"];
    const reply = await w.say("Hey I want to sign up as a manager");
    expect(reply).toContain("already has a PropLane account");
    expect(reply).toContain("https://proplane.ai/auth/confirm?token_hash=HASH&type=magiclink");
    expect(w.f.rows.sms_signup_sessions ?? []).toHaveLength(0);
    expect(w.f.rows.phone_otp_challenges ?? []).toHaveLength(0);
    expect(w.provisioned).toHaveLength(0);
  });

  it("without a link it still says so and points at sign-in", async () => {
    const w = world({ signInLink: async () => null });
    w.state.owners = ["existing-user"];
    expect(await w.say("sign me up as a vendor")).toContain("https://proplane.ai/auth/sign-in");
  });

  it("an account that appears between the first text and the code is never duplicated", async () => {
    const w = world();
    const code = await toCodeStep(w);
    w.state.owners = ["created-elsewhere"];
    const reply = await w.say(code);
    expect(reply).toContain("already has a PropLane account");
    expect(w.provisioned).toHaveLength(0);
    expect(w.f.rows.sms_signup_sessions ?? []).toHaveLength(0);
  });

  it("when provisioning itself finds the phone taken it says so", async () => {
    const w = world({ provision: async () => ({ ok: false, reason: "exists", existingUserId: "u9" }) });
    const code = await toCodeStep(w);
    expect(await w.say(code)).toContain("already has a PropLane account");
  });

  it("an unreadable owner check creates nothing", async () => {
    const w = world({ findOwners: async () => { throw new Error("rpc down"); } });
    expect(await w.say("sign me up as a manager")).toBe(SIGNUP_COPY.checkFailed);
    expect(w.f.rows.sms_signup_sessions ?? []).toHaveLength(0);
  });
});

describe("failures never strand the person", () => {
  it("a provisioning failure keeps the code step: CODE tries again with a new code", async () => {
    let fail = true;
    const w = world({
      provision: async (_db, input) => {
        if (fail) return { ok: false, reason: "unavailable" };
        return { ok: true, userId: "u1", email: `${input.role}@x` };
      },
    });
    const code = await toCodeStep(w);
    expect(await w.say(code)).toBe(SIGNUP_COPY.unavailable);
    fail = false;
    const fresh = codeIn(await w.say("CODE"));
    expect(await w.say(fresh)).toContain("You're set, Jane");
  });

  it("a webhook retry changes nothing: the same MessageSid asks the same question again", async () => {
    const w = world();
    await w.say("sign me up as a manager");
    expect(await w.say("Jane Doe", { sid: "SMretry" })).toContain("business or workspace name");
    // Twilio retried the same text: still at the business question, not advanced to homes.
    expect(await w.say("Jane Doe", { sid: "SMretry" })).toContain("business or workspace name");
    expect(w.f.rows.sms_signup_sessions![0]).toMatchObject({ step: "business", answers: { fullName: "Jane Doe" } });
  });

  it("a retried code turn re-issues a fresh code that works", async () => {
    const w = world();
    await w.say("sign me up as a manager");
    await w.say("Jane Doe");
    await w.say("SKIP");
    await w.say("3");
    const first = codeIn(await w.say("SKIP", { sid: "SMemail" }));
    const second = codeIn(await w.say("SKIP", { sid: "SMemail" }));
    expect(second).not.toBe(first);
    expect(await w.say(second)).toContain("You're set");
  });

  it("start rate limited: a polite wait, no session", async () => {
    const w = world();
    rate.ok = false;
    expect(await w.say("sign me up as a manager")).toBe(SIGNUP_COPY.busy);
    expect(w.f.rows.sms_signup_sessions ?? []).toHaveLength(0);
  });

  it("the table missing (code before the migration): not handled, nothing breaks", async () => {
    const f = linksFakeDb({}, { broken: ["sms_signup_sessions"] });
    const turn = await handleSmsSignupText(f.db, { phoneE164: PHONE, body: "sign me up as a manager", messageSid: "SM1" }, { now: () => T0 });
    expect(turn).toEqual({ handled: false });
  });
});

describe("cancel, restart and expiry", () => {
  it("CANCEL ends the conversation and deletes the row", async () => {
    const w = world();
    await w.say("sign me up as a manager");
    await w.say("Jane Doe");
    expect(await w.say("cancel")).toBe(SIGNUP_COPY.cancelled);
    expect(w.f.rows.sms_signup_sessions ?? []).toHaveLength(0);
    // A normal text afterwards is not a sign-up.
    expect(await w.say("is room 3 available")).toBeNull();
  });

  it("START OVER restarts at the name", async () => {
    const w = world();
    await w.say("sign me up as a manager");
    await w.say("Jane Doe");
    expect(await w.say("start over")).toContain("What is your full name?");
    expect(w.f.rows.sms_signup_sessions![0]).toMatchObject({ step: "name", answers: { source: "explicit" } });
  });

  it("a conversation untouched for a day starts over (a non-sign-up text is then not handled)", async () => {
    const w = world();
    await w.say("sign me up as a manager");
    await w.say("Jane Doe");
    w.state.now = new Date(T0.getTime() + 25 * 60 * 60 * 1000);
    expect(await w.say("Doe Rentals")).toBeNull();
    expect(w.f.rows.sms_signup_sessions ?? []).toHaveLength(0);
  });
});

describe("what is not a sign-up is left alone", () => {
  it.each(["Is Room 3 available?", "hey is there any available jobs in the area to do", "thanks", "I own a house", "when is my rent due"])("%s", async (text) => {
    const w = world();
    expect(await w.say(text)).toBeNull();
    expect(w.f.rows.sms_signup_sessions ?? []).toHaveLength(0);
  });

  it("a number outside the allowed countries is never texted a code", async () => {
    const w = world();
    expect(await w.say("sign me up as a manager", { phone: "+447911123456" })).toBeNull();
  });
});

describe("vendors and residents", () => {
  it("a vendor is asked trade and area, then email and code", async () => {
    const w = world();
    const r1 = await w.say("I want to sign up as a vendor");
    expect(r1).toContain("vendor account");
    expect(r1).toContain("WEBTOKEN-vendor");
    expect(await w.say("Sam Roe")).toContain("What kind of work do you do?");
    expect(await w.say("plumbing")).toBe(SIGNUP_COPY.askArea);
    expect(await w.say("Ballard and Fremont")).toBe(SIGNUP_COPY.askEmail);
    const code = codeIn(await w.say("SKIP"));
    expect(await w.say(code)).toContain("You're set, Sam.");
    expect(w.provisioned[0]).toMatchObject({ role: "vendor", answers: { fullName: "Sam Roe", trade: "plumbing" } });
  });

  it("a vendor lead's trade and area are reused, never asked twice", async () => {
    const w = world();
    w.f.rows.sms_vendor_leads = [{ id: "lead-1", phone_key: KEY, status: "pending", profile: { trade: "cleaning", area: "Ballard" } }];
    await w.say("SIGNUP");
    expect(await w.say("Sam Roe")).toBe(SIGNUP_COPY.askEmail);
    const code = codeIn(await w.say("SKIP"));
    await w.say(code);
    expect(w.provisioned[0]).toMatchObject({ role: "vendor", vendorLeadPhoneKey: KEY, answers: { trade: "cleaning", area: "Ballard" } });
  });

  it("volunteered facts in the first text are kept", async () => {
    const w = world();
    await w.say("I'm a plumber in Ballard, sign me up");
    expect(await w.say("Sam Roe")).toBe(SIGNUP_COPY.askEmail);
  });

  it("a resident is asked which home, gets no web link, and is told the manager connects them", async () => {
    const w = world();
    const r1 = await w.say("I live at 61 Elm Street, can you set me up");
    expect(r1).toContain("resident account");
    expect(r1).not.toContain("/start/");
    expect(await w.say("Rae Lin")).toContain("Which home do you live in?");
    expect(await w.say("61 Elm Street")).toBe(SIGNUP_COPY.askEmail);
    const code = codeIn(await w.say("rae@example.com"));
    const done = await w.say(code);
    expect(done).toContain("You're set, Rae.");
    expect(done).toContain("Your property manager will connect you to your home.");
    expect(w.provisioned[0]).toMatchObject({ role: "resident", answers: { home: "61 Elm Street", email: "rae@example.com" } });
  });
});
