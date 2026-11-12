// Text onboarding link: one text, a phone-bound single-use link, the code gate before anything exists, prefill,
// the account only after the phone is proven, the group text on completion, opt-out respected.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })), clientIpFrom: () => "203.0.113.9" }));

const auth = vi.hoisted(() => ({ owners: vi.fn(), mint: vi.fn(), allowed: vi.fn() }));
vi.mock("@/lib/auth/phone-auth.server", () => ({ phoneOwners: auth.owners, mintPhoneSession: auth.mint }));
vi.mock("@/lib/auth/sms-proven-session.server", () => ({ smsProvenSessionAllowed: auth.allowed }));
const provision = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/one-number/signup/provision.server", () => ({ provisionSmsSignupAccount: provision.fn }));
const group = vi.hoisted(() => ({ add: vi.fn(async () => ({ outcome: "updated" })) }));
vi.mock("@/lib/house-sms-group/sync.server", () => ({ addResidentToHouseSmsGroup: group.add }));
const prefs = vi.hoisted(() => ({ optOut: vi.fn(async () => true) }));
vi.mock("@/lib/house-groups/store.server", () => ({ recordOptOut: prefs.optOut }));
const texts = vi.hoisted(() => ({ send: vi.fn(async () => ({ ok: true })), code: vi.fn() }));
vi.mock("@/lib/one-number/link-text.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/one-number/link-text.server")>()),
  sendWorkspaceText: texts.send,
  sendWorkspacePhoneText: texts.code,
}));
const sources = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/resident-onboarding-link/sources.server", () => ({ loadOnboardingFacts: sources.load }));
const serviceDb = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => serviceDb.db }));
const sessionClient = vi.hoisted(() => ({ setSession: vi.fn(async () => ({})), user: null as null | { id: string } }));
vi.mock("@/lib/supabase/server", () => ({
  createRealIdentitySupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: sessionClient.user } }), setSession: sessionClient.setSession } }),
}));
const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (jar.values.has(name) ? { value: jar.values.get(name) } : undefined) }) }));

import { POST as onboardRoute } from "@/app/api/l/[token]/onboard/route";
import { requestLinkUnlockCode, verifyLinkUnlockCode } from "@/lib/one-number/link-unlock.server";
import { linkSessionCookieName, resolvePhoneBoundLink, type PhoneBoundLink } from "@/lib/one-number/links.server";
import { completeOnboarding, openOnboarding } from "@/lib/resident-onboarding-link/complete.server";
import {
  onboardingLinkText,
  onboardingTargetId,
  parseOnboardingTargetId,
  validateOnboardingInput,
} from "@/lib/resident-onboarding-link/model";
import { sendOnboardingLink } from "@/lib/resident-onboarding-link/send.server";
import type { OnboardingFacts } from "@/lib/resident-onboarding-link/sources.server";
import { linksFakeDb } from "../helpers/links-fake-db";

const WS = "11111111-1111-1111-1111-111111111111";
const PHONE_E164 = "+12065550142";
const PHONE_KEY = "2065550142";

const facts = (over: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  kind: "application", id: "AXIS-1", workspaceId: WS, ownerUserId: "owner-1", propertyId: "prop-1", houseLabel: "5259 Brooklyn",
  roomLabel: "Room 2", moveInDate: "2026-12-01", fullName: "Maya Chen", email: "maya@example.com", phoneE164: PHONE_E164, phoneKey: PHONE_KEY,
  houseRules: "Quiet hours 10pm to 8am.", residentUserId: null, smsConsentAt: "2026-11-01T00:00:00Z", ...over,
});

async function minted(over: Partial<OnboardingFacts> = {}) {
  const fake = linksFakeDb({ portal_workspaces: [{ id: WS, owner_user_id: "owner-1" }] });
  (fake.db as unknown as { auth: unknown }).auth = {
    admin: { getUserById: async (id: string) => ({ data: { user: { id, user_metadata: {} } }, error: null }), updateUserById: async () => ({ data: {}, error: null }) },
  };
  serviceDb.db = fake.db;
  sources.load.mockResolvedValue({ ok: true, facts: facts(over) });
  const sent: string[] = [];
  texts.send.mockImplementation(async (_db: unknown, input: { body: string }) => (sent.push(input.body), { ok: true }));
  const result = await sendOnboardingLink(fake.db, { workspaceId: WS, kind: "application", id: "AXIS-1", actorUserId: "mgr-1" });
  const url = /https?:\/\/\S+\/l\/(\S+)/.exec(sent[0] ?? "");
  const token = url?.[1] ?? "";
  const link = token ? (await resolvePhoneBoundLink(fake.db, token, { count: false }))?.link ?? null : null;
  return { ...fake, result, sent, token, link: link as PhoneBoundLink };
}

beforeEach(() => {
  texts.send.mockReset().mockResolvedValue({ ok: true });
  texts.code.mockReset().mockResolvedValue(true);
  provision.fn.mockReset().mockResolvedValue({ ok: true, userId: "user-new", email: "x@phone.proplane.invalid" });
  auth.owners.mockReset().mockResolvedValue([]);
  auth.allowed.mockReset().mockResolvedValue(true);
  auth.mint.mockReset().mockResolvedValue({ access_token: "a", refresh_token: "r" });
  group.add.mockClear();
  prefs.optOut.mockClear();
  sessionClient.setSession.mockClear();
  sessionClient.user = null;
  jar.values.clear();
});

describe("the link text", () => {
  it("sends ONE text with ONE link to the phone on the record, bound to it, requiring a code, valid 14 days", async () => {
    const m = await minted();
    expect(m.result).toEqual({ ok: true });
    expect(texts.send).toHaveBeenCalledTimes(1);
    expect(texts.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: WS, phoneKey: PHONE_E164, role: "resident", propertyId: "prop-1" }));
    expect(m.sent[0]!.match(/\/l\//g)).toHaveLength(1);
    expect(m.sent[0]).toContain("Hi Maya");
    expect(m.sent[0]).toMatch(/STOP/);
    expect(m.link).toMatchObject({ phoneKey: PHONE_KEY, purpose: "move_in", targetType: "onboarding", targetId: onboardingTargetId("application", "AXIS-1"), requiresOtp: true });
    const days = (Date.parse(m.link.expiresAt!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
  });

  it("stores only the token's hash, never the token or a PKCE code", async () => {
    const m = await minted();
    const stored = JSON.stringify(m.rows.phone_bound_links);
    expect(stored).not.toContain(m.token);
    expect(m.sent[0]).not.toMatch(/[?&]code=/);
  });

  it("a resend replaces the earlier link: exactly one is live", async () => {
    const first = await minted();
    texts.send.mockClear();
    sources.load.mockResolvedValue({ ok: true, facts: facts() });
    const sent: string[] = [];
    texts.send.mockImplementation(async (_db: unknown, input: { body: string }) => (sent.push(input.body), { ok: true }));
    await sendOnboardingLink(first.db, { workspaceId: WS, kind: "application", id: "AXIS-1", actorUserId: "mgr-1" });
    expect(await resolvePhoneBoundLink(first.db, first.token, { count: false })).toBeNull();
    const second = /\/l\/(\S+)/.exec(sent[0]!)![1]!;
    expect(await resolvePhoneBoundLink(first.db, second, { count: false })).not.toBeNull();
  });

  it("refuses a record that is not approved/confirmed or has no phone, texting nobody", async () => {
    const fake = linksFakeDb({ portal_workspaces: [{ id: WS, owner_user_id: "owner-1" }] });
    for (const reason of ["not_ready", "no_phone", "not_found"] as const) {
      sources.load.mockResolvedValue({ ok: false, reason });
      expect(await sendOnboardingLink(fake.db, { workspaceId: WS, kind: "application", id: "x", actorUserId: "m" })).toEqual({ ok: false, reason });
    }
    expect(texts.send).not.toHaveBeenCalled();
    expect(fake.rows.phone_bound_links ?? []).toHaveLength(0);
  });

  it("a refused text (no consent, opted out) revokes the link it just made", async () => {
    const fake = linksFakeDb({ portal_workspaces: [{ id: WS, owner_user_id: "owner-1" }] });
    sources.load.mockResolvedValue({ ok: true, facts: facts() });
    texts.send.mockResolvedValue({ ok: false, error: "scoped_consent_missing" });
    expect(await sendOnboardingLink(fake.db, { workspaceId: WS, kind: "application", id: "AXIS-1", actorUserId: "m" })).toMatchObject({ ok: false, reason: "not_consented" });
    expect(fake.rows.phone_bound_links!.every((l) => l.revoked_at)).toBe(true);
    texts.send.mockResolvedValue({ ok: false, error: "recipient_opted_out" });
    expect(await sendOnboardingLink(fake.db, { workspaceId: WS, kind: "application", id: "AXIS-1", actorUserId: "m" }, { allow: async () => true })).toMatchObject({ ok: false, reason: "send_failed" });
  });

  it("throttles to two sends per record", async () => {
    const fake = linksFakeDb({ portal_workspaces: [{ id: WS, owner_user_id: "owner-1" }] });
    sources.load.mockResolvedValue({ ok: true, facts: facts() });
    expect(await sendOnboardingLink(fake.db, { workspaceId: WS, kind: "application", id: "AXIS-1", actorUserId: "m" }, { allow: async () => false })).toEqual({ ok: false, reason: "rate_limited" });
    expect(texts.send).not.toHaveBeenCalled();
  });

  it("is plain GSM-7 and short", () => {
    const text = onboardingLinkText({ firstName: "Zoë", houseLabel: "5259 Brooklyn — Unit B", url: "https://proplane.ai/l/abc" });
    expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
    expect(text.length).toBeLessThan(260);
  });
});

describe("the record behind an open link", () => {
  it("prefills everything known, masks the phone, and never carries the full number", async () => {
    const m = await minted();
    const opened = await openOnboarding(m.db, m.link);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.prefill).toMatchObject({ fullName: "Maya Chen", email: "maya@example.com", houseLabel: "5259 Brooklyn", roomLabel: "Room 2", moveInDate: "2026-12-01", houseRules: "Quiet hours 10pm to 8am.", maskedPhone: "•••• 0142" });
    expect(JSON.stringify(opened.prefill)).not.toContain("2065550142");
  });

  it("reads as gone when the record's phone was edited since the text, or for any other kind of link", async () => {
    const m = await minted();
    sources.load.mockResolvedValue({ ok: true, facts: facts({ phoneKey: "2065559999", phoneE164: "+12065559999" }) });
    expect(await openOnboarding(m.db, m.link)).toEqual({ ok: false, reason: "gone" });
    sources.load.mockResolvedValue({ ok: true, facts: facts() });
    expect(await openOnboarding(m.db, { ...m.link, targetType: "resident" })).toEqual({ ok: false, reason: "gone" });
    expect(await openOnboarding(m.db, { ...m.link, purpose: "rent" })).toEqual({ ok: false, reason: "gone" });
    sources.load.mockResolvedValue({ ok: false, reason: "not_ready" });
    expect(await openOnboarding(m.db, m.link)).toEqual({ ok: false, reason: "gone" });
  });

  it("the target id round-trips and refuses anything else", () => {
    expect(parseOnboardingTargetId("application:AXIS-1")).toEqual({ kind: "application", id: "AXIS-1" });
    expect(parseOnboardingTargetId("booking:abc")).toEqual({ kind: "booking", id: "abc" });
    expect(parseOnboardingTargetId("resident:abc")).toBeNull();
    expect(parseOnboardingTargetId("application:")).toBeNull();
  });
});

describe("the form", () => {
  it("needs a name, a plausible optional email and, when the house has rules, their acceptance", () => {
    expect(validateOnboardingInput({ fullName: "M" }, { rulesRequired: false })).toMatchObject({ ok: false });
    expect(validateOnboardingInput({ fullName: "Maya Chen", email: "nope" }, { rulesRequired: false })).toMatchObject({ ok: false });
    expect(validateOnboardingInput({ fullName: "Maya Chen" }, { rulesRequired: true })).toMatchObject({ ok: false, error: "Accept the house rules to continue." });
    expect(validateOnboardingInput({ fullName: " Maya   Chen ", email: "", acceptRules: true }, { rulesRequired: true })).toEqual({
      ok: true,
      value: { fullName: "Maya Chen", email: "", acceptRules: true, joinGroupText: true },
    });
  });
});

describe("completeOnboarding", () => {
  const body = { fullName: "Maya Chen", email: "maya@example.com", acceptRules: true, joinGroupText: true };

  it("creates the account for the PROVEN phone, spends the link, adds the house group, texts one welcome and signs in", async () => {
    const m = await minted();
    const r = await completeOnboarding(m.db, { link: m.link, body });
    expect(r).toMatchObject({ ok: true, userId: "user-new", created: true, nextPath: "/resident", session: { access_token: "a" } });
    expect(provision.fn).toHaveBeenCalledWith(m.db, { phoneE164: PHONE_E164, role: "resident", answers: { fullName: "Maya Chen", email: "maya@example.com", home: "5259 Brooklyn" } });
    expect(group.add).toHaveBeenCalledWith(m.db, { workspaceId: WS, propertyId: "prop-1" });
    const welcome = texts.send.mock.calls.filter((c) => (c[1] as { basis: { purpose: string } }).basis.purpose === "resident_onboarding_welcome");
    expect(welcome).toHaveLength(1);
    expect(prefs.optOut).not.toHaveBeenCalled();
    // Single use: the same link now reads as expired.
    expect(await resolvePhoneBoundLink(m.db, m.token, { count: false })).toBeNull();
    expect(await completeOnboarding(m.db, { link: m.link, body })).toMatchObject({ ok: false, status: 404 });
  });

  it("two simultaneous submits cannot both win (the link is claimed before anything is created)", async () => {
    const m = await minted();
    const [a, b] = await Promise.all([completeOnboarding(m.db, { link: m.link, body }), completeOnboarding(m.db, { link: m.link, body })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(provision.fn).toHaveBeenCalledTimes(1);
  });

  it("a failed account step gives the claim back so the same link can be retried", async () => {
    const m = await minted();
    provision.fn.mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    expect(await completeOnboarding(m.db, { link: m.link, body })).toMatchObject({ ok: false, status: 503 });
    expect(await resolvePhoneBoundLink(m.db, m.token, { count: false })).not.toBeNull();
    expect(await completeOnboarding(m.db, { link: m.link, body })).toMatchObject({ ok: true });
  });

  it("an expired link opens nothing", async () => {
    const m = await minted();
    const later = new Date(Date.now() + 15 * 86_400_000);
    expect(await resolvePhoneBoundLink(m.db, m.token, { now: later, count: false })).toBeNull();
  });

  it("a 'no' to the group text is the LEAVE GROUP state, and the account is still made", async () => {
    const m = await minted();
    await completeOnboarding(m.db, { link: m.link, body: { ...body, joinGroupText: false } });
    expect(prefs.optOut).toHaveBeenCalledWith(m.db, WS, PHONE_KEY);
    expect(provision.fn).toHaveBeenCalledTimes(1);
  });

  it("validation failure creates nothing", async () => {
    const m = await minted();
    expect(await completeOnboarding(m.db, { link: m.link, body: { ...body, acceptRules: false } })).toMatchObject({ ok: false, status: 400 });
    expect(provision.fn).not.toHaveBeenCalled();
    expect(await resolvePhoneBoundLink(m.db, m.token, { count: false })).not.toBeNull();
  });

  it("reuses the one account that already owns the phone, but never one with stronger credentials, and never sets a password", async () => {
    const m = await minted();
    auth.owners.mockResolvedValue(["existing-1"]);
    const reused = await completeOnboarding(m.db, { link: m.link, body });
    expect(reused).toMatchObject({ ok: true, userId: "existing-1", created: false });
    expect(provision.fn).not.toHaveBeenCalled();

    const m2 = await minted();
    auth.owners.mockResolvedValue(["manager-1"]);
    auth.allowed.mockResolvedValue(false);
    expect(await completeOnboarding(m2.db, { link: m2.link, body })).toMatchObject({ ok: false, status: 409 });
    auth.owners.mockResolvedValue(["a", "b"]);
    expect(await completeOnboarding(m2.db, { link: m2.link, body })).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses a record already bound to a DIFFERENT account", async () => {
    const m = await minted({ residentUserId: "someone-else" });
    expect(await completeOnboarding(m.db, { link: m.link, body })).toMatchObject({ ok: false, status: 409 });
  });

  it("lands on Verify ID when the manager requires it for the house", async () => {
    const m = await minted();
    const r = await completeOnboarding(m.db, { link: m.link, body }, { verifyIdRequired: async () => true });
    expect(r).toMatchObject({ ok: true, nextPath: "/resident/profile#verification" });
  });

  it("a failure after the account (group add, welcome) never fails the onboarding", async () => {
    const m = await minted();
    group.add.mockRejectedValueOnce(new Error("twilio down"));
    texts.send.mockRejectedValue(new Error("sms down"));
    expect(await completeOnboarding(m.db, { link: m.link, body })).toMatchObject({ ok: true });
  });
});

describe("POST /api/l/<token>/onboard: no account before the phone is proven", () => {
  const request = (token: string, payload: unknown) =>
    new Request(`https://app.example.test/api/l/${token}/onboard`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
  const body = { fullName: "Maya Chen", email: "", acceptRules: true, joinGroupText: true };

  it("answers 401 with no verified session on the link and creates nothing", async () => {
    const m = await minted();
    const res = await onboardRoute(request(m.token, body), ctx(m.token));
    expect(res.status).toBe(401);
    expect(provision.fn).not.toHaveBeenCalled();
    expect(group.add).not.toHaveBeenCalled();
  });

  it("answers the expired view for an unknown token or another kind of link", async () => {
    const m = await minted();
    expect((await onboardRoute(request("x".repeat(43), body), ctx("x".repeat(43)))).status).toBe(404);
    expect(provision.fn).not.toHaveBeenCalled();
    expect(m.link).toBeTruthy();
  });

  it("after the code is verified it completes, opens the session and points at the portal", async () => {
    const m = await minted();
    expect((await requestLinkUnlockCode(m.db, m.link)).ok).toBe(true);
    const code = /\b(\d{6})\b/.exec((texts.code.mock.calls[0]![1] as { body: string }).body)![1]!;
    const verified = await verifyLinkUnlockCode(m.db, m.link, code);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    jar.values.set(linkSessionCookieName(m.token), verified.session.token);
    const res = await onboardRoute(request(m.token, body), ctx(m.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, nextPath: "/resident" });
    expect(sessionClient.setSession).toHaveBeenCalledTimes(1);
    expect(provision.fn).toHaveBeenCalledTimes(1);
    // A second submit finds the link spent.
    expect((await onboardRoute(request(m.token, body), ctx(m.token))).status).toBe(404);
  });

  it("a session minted for ANOTHER link does not open this one", async () => {
    const a = await minted();
    expect((await requestLinkUnlockCode(a.db, a.link)).ok).toBe(true);
    const code = /\b(\d{6})\b/.exec((texts.code.mock.calls[0]![1] as { body: string }).body)![1]!;
    const verified = await verifyLinkUnlockCode(a.db, a.link, code);
    if (!verified.ok) throw new Error("setup");
    const b = await minted();
    jar.values.set(linkSessionCookieName(b.token), verified.session.token);
    expect((await onboardRoute(request(b.token, body), ctx(b.token))).status).toBe(401);
  });
});
