import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { phoneOwners } from "@/lib/auth/phone-auth.server";
import { toGsm7 } from "@/lib/one-number/lead-qualifying";
import { mintSetupLink } from "@/lib/one-number/onboarding/setup-links.server";
import { requestPhoneOtp, verifyPhoneOtp } from "@/lib/one-number/phone-otp.server";
import {
  firstNameOf,
  isCancelText,
  isRestartText,
  isResendCodeText,
  parseBusinessName,
  parseEmailAnswer,
  parseFullName,
  parseHomeAnswer,
  parseHomeCount,
  parseShortAnswer,
  readCodeReply,
  readSignupIntent,
  readSignupRoleAnswer,
  type SignupRole,
} from "@/lib/one-number/signup/intent";
import { provisionSmsSignupAccount, type SmsSignupInput, type SmsSignupResult } from "@/lib/one-number/signup/provision.server";
import { mintPhoneSignInLink } from "@/lib/one-number/signup/sign-in-link.server";
import {
  deleteSignupSession,
  readSignupSession,
  signupSessionExpired,
  writeSignupSession,
  type SignupAnswers,
  type SignupSession,
  type SignupStep,
} from "@/lib/one-number/signup/state.server";
import { extractArea, extractTrade } from "@/lib/one-number/onboarding/vendor-intake";
import { isAllowedPhoneAuthDestination } from "@/lib/phone-e164";
import { rateLimit } from "@/lib/rate-limit";
import { createHash } from "node:crypto";

/**
 * Sign up by text, for every role (docs/agents/one-number.md § W26). One question per text; the person ends with a real
 * account that is the same one the website makes, and a one-tap link into the portal.
 *
 *   role (only when the words did not say) -> full name -> role details -> optional email -> CODE -> account
 *
 *   manager   business / workspace name, how many homes
 *   vendor    trade, area (a pending vendor lead's answers are reused, never asked twice)
 *   resident  the home they live in (a hint only: nothing is bound to a home or workspace)
 *
 * PROOF OF THE PHONE. Caller ID can be spoofed, so nothing is created on the strength of "this text came from +1...".
 * The last question is a 6-digit code we text TO that number in our own message (`phone_otp_challenges`, purpose
 * `sms_signup`: keyed-HMAC hash bound to challenge + phone, 10 minutes, 5 attempts, 3 sends per phone per hour, 10 wrong
 * codes in 24 hours lock the phone). The person must text it back. Only then is anything created.
 *
 * ONE ACCOUNT PER PHONE. A phone that already has an account (verified profile phone, confirmed Auth phone, or a
 * texter contact) is never given a second one: it is told so and sent a one-tap sign-in link instead.
 *
 * The typed email is a claim. It is stored unverified in the account's metadata and is never the login.
 * No model runs here: the copy is fixed.
 */

export type SignupTurn = { handled: false } | { handled: true; reply: string };

export const SIGNUP_OTP_SUBJECT = "sms_signup";
export const SIGNUP_STARTS_PER_PHONE_PER_HOUR = 6;
export const SIGNUP_STARTS_GLOBAL_PER_HOUR = 400;

const ROLE_NAME: Record<SignupRole, string> = { manager: "property manager", vendor: "vendor", resident: "resident" };

export const SIGNUP_COPY = {
  stop: "Reply STOP to opt out.",
  askRole: "Welcome to PropLane! Are you a property manager, a vendor, or a resident? Reply 1 for manager, 2 for vendor, 3 for resident.",
  retryRole: "Sorry, I did not get that. Reply 1 for property manager, 2 for vendor, or 3 for resident.",
  askName: "What is your full name?",
  retryName: "Sorry, I did not catch that. What is your full name? (Reply CANCEL to stop.)",
  askBusiness: (first: string) => `Thanks, ${first}. What is your business or workspace name? Reply SKIP to decide later.`,
  retryBusiness: "Sorry, I did not catch that. What is your business or workspace name? Reply SKIP to decide later.",
  askHomes: "How many homes do you manage? A number is fine, or 0 if you are just starting.",
  retryHomes: "Sorry, I need a number. How many homes do you manage? (0 if none yet, or reply SKIP.)",
  askTrade: (first: string) => `Thanks, ${first}. What kind of work do you do? For example cleaning, plumbing or handyman.`,
  retryTrade: "Sorry, I did not catch that. What kind of work do you do? For example cleaning, plumbing or handyman.",
  askArea: "Which city or zip codes do you cover?",
  retryArea: "Sorry, I did not catch that. Which city or zip codes do you cover?",
  askHome: (first: string) => `Thanks, ${first}. Which home do you live in? A street address is fine. Reply SKIP if you are not sure.`,
  retryHome: "Sorry, I did not catch that. Which home do you live in? A street address is fine, or reply SKIP.",
  askEmail: "Want receipts and updates by email too? Send your email, or reply SKIP.",
  retryEmail: "That does not look like an email. Send it again, or reply SKIP.",
  cancelled: "No problem, I stopped that. Text SIGNUP any time to start again.",
  restarted: "Okay, starting over.",
  needCode: "Reply with the 6-digit code I texted you, or reply CODE for a new one.",
  wrongCode: "That code does not match. Try again, or reply CODE for a new one.",
  expiredCode: "That code expired. Reply CODE and I will text a new one.",
  lockedCode: "Too many wrong tries on this number. Please wait an hour, then text CODE.",
  noCode: "I do not have a code out for you. Reply CODE and I will text one.",
  rateLimitedCode: "I have sent a few codes to this number already. Please wait about an hour, then reply CODE.",
  unavailable: "I could not finish that just now. Reply CODE to try again in a moment.",
  busy: "I cannot start a sign-up for this number right now. Please try again in about an hour.",
  checkFailed: "I could not check that just now. Please text me again in a few minutes.",
} as const;

export function codeMessage(code: string): string {
  return `Last step: to confirm this phone is yours, reply with this code: ${code}. It expires in 10 minutes. Do not share it.`;
}

export type SignupDeps = {
  now?: () => Date;
  origin?: string;
  /** Test seam: the account provisioning. */
  provision?: (db: SupabaseClient, input: SmsSignupInput) => Promise<SmsSignupResult>;
  /** Test seam: who already owns this phone. */
  findOwners?: (db: SupabaseClient, phone: string) => Promise<string[]>;
  /** Test seam: the one-tap sign-in link for the account that owns this phone. */
  signInLink?: (db: SupabaseClient, input: { phoneE164: string; userId: string }) => Promise<string | null>;
  /** Test seam: the web sign-up link texted with the first question (manager / vendor). */
  webLink?: (db: SupabaseClient, input: { role: SignupRole; phoneKey: string; vendorLeadId?: string }) => Promise<string | null>;
};

const phoneKeyOf = (e164: string): string => e164.replace(/\D/g, "").slice(-10);
const hashOf = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 32);

const say = (text: string): SignupTurn => ({ handled: true, reply: toGsm7(text) });

const ORDER: Record<SignupRole, SignupStep[]> = {
  manager: ["name", "business", "homes", "email", "code"],
  vendor: ["name", "trade", "area", "email", "code"],
  resident: ["name", "home", "email", "code"],
};

/** The question after `after`, skipping a vendor's trade / area that a lead or the first text already answered. */
export function nextStep(role: SignupRole, answers: SignupAnswers, after: SignupStep): SignupStep {
  const order = ORDER[role];
  const at = order.indexOf(after);
  for (const step of order.slice(at + 1)) {
    if (step === "trade" && answers.trade) continue;
    if (step === "area" && answers.area) continue;
    return step;
  }
  return "code";
}

function questionFor(step: SignupStep, session: Pick<SignupSession, "role" | "answers">): string {
  const first = firstNameOf(session.answers.fullName ?? "");
  switch (step) {
    case "role": return SIGNUP_COPY.askRole;
    case "name": return SIGNUP_COPY.askName;
    case "business": return SIGNUP_COPY.askBusiness(first);
    case "homes": return SIGNUP_COPY.askHomes;
    case "trade": return SIGNUP_COPY.askTrade(first);
    case "area": return SIGNUP_COPY.askArea;
    case "home": return SIGNUP_COPY.askHome(first);
    case "email": return SIGNUP_COPY.askEmail;
    default: return SIGNUP_COPY.needCode;
  }
}

function retryFor(step: SignupStep): string {
  switch (step) {
    case "role": return SIGNUP_COPY.retryRole;
    case "name": return SIGNUP_COPY.retryName;
    case "business": return SIGNUP_COPY.retryBusiness;
    case "homes": return SIGNUP_COPY.retryHomes;
    case "trade": return SIGNUP_COPY.retryTrade;
    case "area": return SIGNUP_COPY.retryArea;
    case "home": return SIGNUP_COPY.retryHome;
    case "email": return SIGNUP_COPY.retryEmail;
    default: return SIGNUP_COPY.needCode;
  }
}

async function defaultWebLink(db: SupabaseClient, input: { role: SignupRole; phoneKey: string; vendorLeadId?: string }, origin?: string): Promise<string | null> {
  if (input.role === "resident") return null;
  const minted = await mintSetupLink(db, {
    kind: input.role === "manager" ? "landlord" : "vendor",
    phoneKey: input.phoneKey,
    context: { source: "direct", ...(input.vendorLeadId ? { vendorLeadId: input.vendorLeadId } : {}) },
    origin,
  });
  return minted.ok ? minted.url : null;
}

/** A live vendor lead for this phone (the PropLane line already captured one): its trade and area are not asked again. */
async function readVendorLead(db: SupabaseClient, phoneKey: string): Promise<{ id: string; trade?: string; area?: string } | null> {
  const { data, error } = await db.from("sms_vendor_leads").select("id, profile").eq("phone_key", phoneKey).in("status", ["collecting", "pending"]).maybeSingle();
  if (error || !data) return null;
  const row = data as { id?: unknown; profile?: unknown };
  const profile = row.profile && typeof row.profile === "object" && !Array.isArray(row.profile) ? (row.profile as Record<string, unknown>) : {};
  return {
    id: String(row.id ?? ""),
    trade: typeof profile.trade === "string" && profile.trade ? profile.trade : undefined,
    area: typeof profile.area === "string" && profile.area ? profile.area : typeof profile.areaText === "string" && profile.areaText ? profile.areaText : undefined,
  };
}

async function existingAccountReply(
  db: SupabaseClient,
  phone: string,
  owners: string[],
  deps: SignupDeps,
): Promise<SignupTurn> {
  const origin = (deps.origin ?? resolveEmailLinkBaseUrl()).replace(/\/$/, "");
  if (owners.length === 1) {
    const mint = deps.signInLink ?? mintPhoneSignInLink;
    const link = await mint(db, { phoneE164: phone, userId: owners[0]! });
    if (link) return say(`This number already has a PropLane account, so I will not make a second one. Open it with this one-tap link: ${link}`);
  }
  return say(`This number already has a PropLane account, so I will not make a second one. Sign in here: ${origin}/auth/sign-in`);
}

/**
 * One inbound text. `handled: false` = this is not a sign-up conversation (the caller continues exactly as before).
 * Anything else is answered here.
 */
export async function handleSmsSignupText(
  db: SupabaseClient,
  input: { phoneE164: string; body: string; messageSid: string },
  deps: SignupDeps = {},
): Promise<SignupTurn> {
  const now = (deps.now ?? (() => new Date()))();
  const phone = input.phoneE164;
  const phoneKey = phoneKeyOf(phone);
  const body = String(input.body ?? "").trim().slice(0, 500);
  if (!/^\d{10}$/.test(phoneKey) || !body) return { handled: false };
  // Only numbers a code can safely be texted to (US / Canada by default; the same allowlist phone sign-in uses).
  if (!isAllowedPhoneAuthDestination(phone)) return { handled: false };

  const read = await readSignupSession(db, phoneKey);
  if (!read.available) return { handled: false };
  let session = read.session;
  if (session && (session.step === "done" || signupSessionExpired(session, now))) {
    if (session.step !== "done") await deleteSignupSession(db, phoneKey);
    session = null;
  }

  if (!session) return startSignup(db, { phone, phoneKey, body, sid: input.messageSid, now }, deps);
  return continueSignup(db, session, { phone, phoneKey, body, sid: input.messageSid, now }, deps);
}

type Turn = { phone: string; phoneKey: string; body: string; sid: string; now: Date };

async function startSignup(db: SupabaseClient, turn: Turn, deps: SignupDeps): Promise<SignupTurn> {
  const intent = readSignupIntent(turn.body);
  if (!intent.wantsSignup) return { handled: false };

  const owners = await (deps.findOwners ?? phoneOwners)(db, turn.phone).catch(() => null);
  if (owners === null) return say(SIGNUP_COPY.checkFailed);
  if (owners.length > 0) return existingAccountReply(db, turn.phone, owners, deps);

  // Starting costs us a text each time, so a phone and the whole line are rate limited.
  const byPhone = await rateLimit(`sms-signup-start:${hashOf(turn.phone)}`, SIGNUP_STARTS_PER_PHONE_PER_HOUR, 60 * 60 * 1000);
  const global = byPhone.ok ? await rateLimit("sms-signup-start-global", SIGNUP_STARTS_GLOBAL_PER_HOUR, 60 * 60 * 1000) : byPhone;
  if (!global.ok) return say(SIGNUP_COPY.busy);

  const lead = await readVendorLead(db, turn.phoneKey).catch(() => null);
  const role: SignupRole | null = intent.role ?? (lead ? "vendor" : null);
  const answers: SignupAnswers = { source: intent.implicit ? "implicit" : lead && !intent.role ? "vendor_lead" : "explicit" };
  if (role === "vendor" && lead) {
    if (lead.trade) answers.trade = lead.trade;
    if (lead.area) answers.area = lead.area;
  }
  // Volunteered facts in the first text are kept ("I'm a plumber in Ballard, sign me up").
  if (role === "vendor") {
    answers.trade ??= extractTrade(turn.body) ?? undefined;
    answers.area ??= extractArea(turn.body) ?? undefined;
  }
  const step: SignupStep = role ? "name" : "role";
  await pruneStaleSessions(db, turn.now);
  const saved = await writeSignupSession(db, { phoneKey: turn.phoneKey, phoneE164: turn.phone, role, step, answers, lastSid: turn.sid, lastKind: "start", now: turn.now });
  if (!saved) return { handled: false };
  if (!role) return say(`${SIGNUP_COPY.askRole} ${SIGNUP_COPY.stop}`);

  const link = await (deps.webLink
    ? deps.webLink(db, { role, phoneKey: turn.phoneKey, vendorLeadId: lead?.id })
    : defaultWebLink(db, { role, phoneKey: turn.phoneKey, vendorLeadId: lead?.id }, deps.origin)
  ).catch(() => null);
  return say(introText(role, link));
}

function introText(role: SignupRole, webLink: string | null): string {
  const lead = `Welcome to PropLane! I will set up your ${ROLE_NAME[role]} account right here by text. ${SIGNUP_COPY.askName}`;
  const web = webLink ? ` Prefer the website? Sign up here: ${webLink}` : "";
  return `${lead}${web} ${SIGNUP_COPY.stop}`;
}

async function pruneStaleSessions(db: SupabaseClient, now: Date): Promise<void> {
  // An abandoned conversation keeps a name and maybe an email; nothing needs them after a week.
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await db.from("sms_signup_sessions").delete().lt("updated_at", cutoff).is("completed_at", null).then(() => undefined, () => undefined);
}

async function continueSignup(db: SupabaseClient, session: SignupSession, turn: Turn, deps: SignupDeps): Promise<SignupTurn> {
  const { phone, phoneKey, body, sid, now } = turn;
  const save = (patch: { role?: SignupRole | null; step?: SignupStep; answers?: SignupAnswers; kind: string; userId?: string | null; completedAt?: string | null }) =>
    writeSignupSession(db, {
      phoneKey,
      phoneE164: phone,
      role: patch.role !== undefined ? patch.role : session.role,
      step: patch.step ?? session.step,
      answers: patch.answers ?? session.answers,
      lastSid: sid,
      lastKind: patch.kind,
      userId: patch.userId ?? null,
      completedAt: patch.completedAt ?? null,
      now,
    });

  // A retried webhook changes nothing: ask the current question again (a code is re-issued, the old one stops working).
  const replay = Boolean(sid) && session.lastSid === sid;

  if (!replay && isCancelText(body)) {
    await deleteSignupSession(db, phoneKey);
    return say(SIGNUP_COPY.cancelled);
  }
  if (!replay && isRestartText(body)) {
    const step: SignupStep = session.role ? "name" : "role";
    await save({ step, answers: { source: session.answers.source }, kind: "restart" });
    return say(`${SIGNUP_COPY.restarted} ${questionFor(step, { role: session.role, answers: {} })}`);
  }

  // The owner may have been created between texts (the web link, another device): never a second account.
  const role = session.role;
  if (session.step === "role" || !role) {
    if (replay) return say(SIGNUP_COPY.askRole);
    const picked = readSignupRoleAnswer(body);
    if (!picked) {
      await save({ kind: "retry" });
      return say(SIGNUP_COPY.retryRole);
    }
    const lead = picked === "vendor" ? await readVendorLead(db, phoneKey).catch(() => null) : null;
    const answers: SignupAnswers = { ...session.answers };
    if (lead?.trade) answers.trade = lead.trade;
    if (lead?.area) answers.area = lead.area;
    await save({ role: picked, step: "name", answers, kind: "role" });
    const link = await (deps.webLink
      ? deps.webLink(db, { role: picked, phoneKey, vendorLeadId: lead?.id })
      : defaultWebLink(db, { role: picked, phoneKey, vendorLeadId: lead?.id }, deps.origin)
    ).catch(() => null);
    return say(introText(picked, link));
  }

  if (session.step === "code") return codeStep(db, { ...session, role }, turn, deps, replay, save);
  if (replay) return say(questionFor(session.step, session));

  const answers: SignupAnswers = { ...session.answers };
  const advance = async (kind: string): Promise<SignupTurn> => {
    const step = nextStep(role, answers, session.step);
    await save({ step, answers, kind });
    if (step === "code") return issueCode(db, turn);
    return say(questionFor(step, { role, answers }));
  };
  const retry = async (): Promise<SignupTurn> => {
    await save({ kind: "retry" });
    return say(retryFor(session.step));
  };

  switch (session.step) {
    case "name": {
      const name = parseFullName(body);
      if (!name) return retry();
      answers.fullName = name;
      return advance("name");
    }
    case "business": {
      const parsed = parseBusinessName(body);
      if (parsed.kind === "invalid") return retry();
      if (parsed.kind === "value") answers.businessName = parsed.value;
      return advance("business");
    }
    case "homes": {
      const parsed = parseHomeCount(body);
      if (parsed.kind === "invalid") return retry();
      if (parsed.kind === "value") answers.homes = parsed.value;
      return advance("homes");
    }
    case "trade": {
      const parsed = parseShortAnswer(body, 60);
      if (parsed.kind !== "value") return retry();
      answers.trade = extractTrade(parsed.value) ?? parsed.value;
      return advance("trade");
    }
    case "area": {
      const parsed = parseShortAnswer(body, 80);
      if (parsed.kind !== "value") return retry();
      answers.area = extractArea(parsed.value) ?? parsed.value;
      return advance("area");
    }
    case "home": {
      const parsed = parseHomeAnswer(body);
      if (parsed.kind === "invalid") return retry();
      if (parsed.kind === "value") answers.home = parsed.value;
      return advance("home");
    }
    case "email": {
      const parsed = parseEmailAnswer(body);
      if (parsed.kind === "invalid") return retry();
      if (parsed.kind === "value") answers.email = parsed.value;
      return advance("email");
    }
    default:
      return retry();
  }
}

/** Text the proof code in OUR message. Nothing is created until the person texts it back. */
async function issueCode(db: SupabaseClient, turn: Turn): Promise<SignupTurn> {
  let text = "";
  const requested = await requestPhoneOtp(db, {
    phoneKey: turn.phoneKey,
    purpose: "sms_signup",
    subjectId: SIGNUP_OTP_SUBJECT,
    now: turn.now,
    // The code goes out as this turn's reply; only the sender of the text can receive it.
    send: async (code) => {
      text = codeMessage(code);
      return true;
    },
  });
  if (!requested.ok) return say(requested.reason === "rate_limited" ? SIGNUP_COPY.rateLimitedCode : SIGNUP_COPY.unavailable);
  return say(text);
}

async function codeStep(
  db: SupabaseClient,
  session: SignupSession & { role: SignupRole },
  turn: Turn,
  deps: SignupDeps,
  replay: boolean,
  save: (patch: { role?: SignupRole | null; step?: SignupStep; answers?: SignupAnswers; kind: string; userId?: string | null; completedAt?: string | null }) => Promise<boolean>,
): Promise<SignupTurn> {
  const { phone, phoneKey, body, now } = turn;
  if (replay || isResendCodeText(body)) {
    await save({ kind: "code_resend" });
    return issueCode(db, turn);
  }
  const code = readCodeReply(body);
  if (!code) {
    await save({ kind: "retry" });
    return say(SIGNUP_COPY.needCode);
  }
  const verified = await verifyPhoneOtp(db, { phoneKey, purpose: "sms_signup", subjectId: SIGNUP_OTP_SUBJECT, code, now });
  if (!verified.ok) {
    await save({ kind: "code_wrong" });
    switch (verified.reason) {
      case "expired": return say(SIGNUP_COPY.expiredCode);
      case "locked": return say(SIGNUP_COPY.lockedCode);
      case "no_challenge": return say(SIGNUP_COPY.noCode);
      default: return say(SIGNUP_COPY.wrongCode);
    }
  }

  // The phone is proven. Last look for an account created since the first text, then the same provisioning the website uses.
  const owners = await (deps.findOwners ?? phoneOwners)(db, phone).catch(() => null);
  if (owners === null) return say(SIGNUP_COPY.unavailable);
  if (owners.length > 0) {
    await deleteSignupSession(db, phoneKey);
    return existingAccountReply(db, phone, owners, deps);
  }
  const lead = session.role === "vendor" ? await readVendorLead(db, phoneKey).catch(() => null) : null;
  const result = await (deps.provision ?? provisionSmsSignupAccount)(db, {
    phoneE164: phone,
    role: session.role,
    answers: session.answers,
    ...(lead ? { vendorLeadPhoneKey: phoneKey } : {}),
  });
  if (!result.ok) {
    if (result.reason === "exists") {
      await deleteSignupSession(db, phoneKey);
      return existingAccountReply(db, phone, result.existingUserId ? [result.existingUserId] : [], deps);
    }
    await save({ kind: "provision_failed" });
    return say(SIGNUP_COPY.unavailable);
  }

  // Done: keep who they became, drop what they typed.
  await save({ step: "done", answers: { source: session.answers.source }, kind: "done", userId: result.userId, completedAt: now.toISOString() });
  await db.from("sms_setup_links").update({ revoked_at: now.toISOString() }).eq("phone_key", phoneKey).is("used_at", null).is("revoked_at", null).then(() => undefined, () => undefined);

  const origin = (deps.origin ?? resolveEmailLinkBaseUrl()).replace(/\/$/, "");
  const link = await (deps.signInLink ?? mintPhoneSignInLink)(db, { phoneE164: phone, userId: result.userId });
  const first = firstNameOf(session.answers.fullName ?? "");
  const tail = session.role === "resident" ? " Your property manager will connect you to your home." : "";
  return say(`You're set, ${first}. Your PropLane account is ready. Manage everything right here by text, or open your portal: ${link ?? `${origin}/auth/sign-in`}${tail}`);
}
