// Personal account link (design-1112 §5) and Text us (§1): the link is a phone-bound `account` link (hash stored,
// 14 days, no code gate), single use, replaces its predecessor; the page opens account creation with the phone already
// linked and the new account lands connected to its history; "Text us" only ever names the configured line.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));
const rate = vi.hoisted(() => ({ ok: true }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: rate.ok })), clientIpFrom: () => "203.0.113.9" }));

const auth = vi.hoisted(() => ({ owners: vi.fn(), mint: vi.fn(), allowed: vi.fn() }));
vi.mock("@/lib/auth/phone-auth.server", () => ({ phoneOwners: auth.owners, mintPhoneSession: auth.mint }));
vi.mock("@/lib/auth/sms-proven-session.server", () => ({ smsProvenSessionAllowed: auth.allowed }));
const provision = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/one-number/signup/provision.server", () => ({ provisionSmsSignupAccount: provision.fn }));
const spine = vi.hoisted(() => ({ link: vi.fn(async () => ({ linked: true, threads: 1 })) }));
vi.mock("@/lib/prospect-spine/index.server", () => ({ linkAccountToProspectRecord: spine.link }));
const serviceDb = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => serviceDb.db }));
const sessionClient = vi.hoisted(() => ({ setSession: vi.fn(async () => ({})), user: null as null | { id: string } }));
vi.mock("@/lib/supabase/server", () => ({
  createRealIdentitySupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: sessionClient.user } }), setSession: sessionClient.setSession } }),
}));

import { POST as accountRoute } from "@/app/api/l/[token]/account/route";
import { PHONE_BOUND_LINK_POLICY } from "@/lib/one-number/contracts";
import { resolveLinkDestination } from "@/lib/one-number/link-destinations.server";
import { resolvePhoneBoundLink, type PhoneBoundLink } from "@/lib/one-number/links.server";
import { mintPersonalAccountLink } from "@/lib/personal-link/index.server";
import { completePersonalAccount } from "@/lib/personal-link/complete.server";
import { parsePersonalLinkTarget, personalLinkTargetId, validatePersonalAccountInput } from "@/lib/personal-link/model";
import { textUsBody, textUsHref } from "@/lib/personal-link/text-us";
import { linksFakeDb } from "../helpers/links-fake-db";

const WS = "11111111-1111-1111-1111-111111111111";
const PHONE = "+12065550142";
const PHONE_KEY = "2065550142";

function seed() {
  const fake = linksFakeDb({
    portal_workspaces: [{ id: WS, owner_user_id: "owner-1" }],
    manager_property_records: [{ id: "prop-1", workspace_id: WS, manager_user_id: "owner-1", property_data: { buildingName: "5259 Brooklyn" }, row_data: {} }],
  });
  (fake.db as unknown as { auth: unknown }).auth = {
    admin: { getUserById: async (id: string) => ({ data: { user: { id, user_metadata: {} } }, error: null }), updateUserById: async () => ({ data: {}, error: null }) },
  };
  serviceDb.db = fake.db;
  return fake;
}

async function minted(propertyId: string | null = "prop-1") {
  const fake = seed();
  const url = await mintPersonalAccountLink(fake.db, { phoneE164: PHONE, workspaceId: WS, propertyId });
  const token = /\/l\/(\S+)$/.exec(url ?? "")?.[1] ?? "";
  const link = token ? (await resolvePhoneBoundLink(fake.db, token, { count: false }))?.link ?? null : null;
  return { ...fake, url, token, link: link as PhoneBoundLink };
}

const req = (token: string, body: unknown) =>
  new Request(`https://proplane.test/api/l/${token}/account`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  rate.ok = true;
  auth.owners.mockReset().mockResolvedValue([]);
  auth.allowed.mockReset().mockResolvedValue(true);
  auth.mint.mockReset().mockResolvedValue({ access_token: "a", refresh_token: "r" });
  provision.fn.mockReset().mockResolvedValue({ ok: true, userId: "user-new", email: "x@phone.proplane.invalid" });
  spine.link.mockClear();
  sessionClient.setSession.mockClear();
  sessionClient.user = null;
});

describe("mintPersonalAccountLink", () => {
  it("mints a /l/<token> link for purpose account, bound to the phone, no code gate, valid 14 days, hash only", async () => {
    const m = await minted();
    expect(m.url).toMatch(/\/l\/[A-Za-z0-9_-]{32,}$/);
    expect(m.link).toMatchObject({
      phoneKey: PHONE_KEY,
      workspaceId: WS,
      purpose: "account",
      targetType: "prospect",
      targetId: personalLinkTargetId(WS, "prop-1"),
      requiresOtp: false,
    });
    expect(PHONE_BOUND_LINK_POLICY.account).toEqual({ ttlHours: 24 * 14, requiresOtp: false });
    const days = (Date.parse(m.link.expiresAt!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
    expect(JSON.stringify(m.rows.phone_bound_links)).not.toContain(m.token);
  });

  it("a newer link for the same phone and home replaces the older one: exactly one is live", async () => {
    const m = await minted();
    const again = await mintPersonalAccountLink(m.db, { phoneE164: PHONE, workspaceId: WS, propertyId: "prop-1" });
    expect(again).not.toBeNull();
    expect(await resolvePhoneBoundLink(m.db, m.token, { count: false })).toBeNull();
  });

  it("is null for a bad phone, a missing workspace, a rate-limited phone, and never throws", async () => {
    const fake = seed();
    expect(await mintPersonalAccountLink(fake.db, { phoneE164: "nope", workspaceId: WS })).toBeNull();
    expect(await mintPersonalAccountLink(fake.db, { phoneE164: PHONE, workspaceId: "22222222-2222-2222-2222-222222222222" })).toBeNull();
    rate.ok = false;
    expect(await mintPersonalAccountLink(fake.db, { phoneE164: PHONE, workspaceId: WS })).toBeNull();
  });

  it("the target id round-trips and refuses anything else", () => {
    expect(parsePersonalLinkTarget(personalLinkTargetId(WS, "prop-1"))).toEqual({ workspaceId: WS, propertyId: "prop-1" });
    expect(parsePersonalLinkTarget(personalLinkTargetId(WS, null))).toEqual({ workspaceId: WS, propertyId: null });
    expect(parsePersonalLinkTarget("not-a-uuid:prop")).toBeNull();
    expect(parsePersonalLinkTarget("nope")).toBeNull();
  });
});

describe("the link's destination", () => {
  it("opens the account form with the house and a masked phone, never the full number", async () => {
    const m = await minted();
    const destination = await resolveLinkDestination(m.db, m.link);
    expect(destination).toEqual({ kind: "account", prefill: { houseLabel: "5259 Brooklyn", maskedPhone: "•••• 0142" } });
    expect(JSON.stringify(destination)).not.toContain(PHONE_KEY);
  });

  it("a home that left the workspace loses its label but the link still opens an account", async () => {
    const m = await minted();
    m.rows.manager_property_records![0]!.workspace_id = "33333333-3333-3333-3333-333333333333";
    expect(await resolveLinkDestination(m.db, m.link)).toEqual({ kind: "account", prefill: { houseLabel: "", maskedPhone: "•••• 0142" } });
  });

  it("is gone for a workspace that no longer exists or a link of another kind", async () => {
    const m = await minted();
    m.rows.portal_workspaces!.length = 0;
    expect(await resolveLinkDestination(m.db, m.link)).toEqual({ kind: "gone" });
    const other = await minted();
    expect(await resolveLinkDestination(other.db, { ...other.link, targetType: "listing" })).toEqual({ kind: "gone" });
  });
});

describe("finishing the link", () => {
  it("a new account is created for the proven phone, linked to its history once, signed in, and the link is spent", async () => {
    const m = await minted();
    const res = await accountRoute(req(m.token, { fullName: "Maya Chen", email: "maya@example.com", password: "correct horse" }), { params: Promise.resolve({ token: m.token }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, signedIn: true, nextPath: "/resident/communication", propertyPath: "/resident/applications/apply?propertyId=prop-1" });
    expect(provision.fn).toHaveBeenCalledWith(expect.anything(), { phoneE164: PHONE, role: "resident", answers: { fullName: "Maya Chen", email: "maya@example.com", home: "5259 Brooklyn" } });
    expect(spine.link).toHaveBeenCalledTimes(1);
    expect(spine.link).toHaveBeenCalledWith(expect.anything(), { userId: "user-new", phoneE164: PHONE });
    expect(sessionClient.setSession).toHaveBeenCalledTimes(1);
    // Reopening reads as expired (the same answer as any dead link), and a second submit creates nothing.
    expect(await resolvePhoneBoundLink(m.db, m.token, { count: false })).toBeNull();
    const again = await accountRoute(req(m.token, { fullName: "Maya Chen", password: "correct horse" }), { params: Promise.resolve({ token: m.token }) });
    expect(again.status).toBe(404);
    expect(provision.fn).toHaveBeenCalledTimes(1);
    expect(spine.link).toHaveBeenCalledTimes(1);
  });

  it("an existing phone-only account signs in and is linked; no second account is made", async () => {
    const m = await minted();
    auth.owners.mockResolvedValue(["user-old"]);
    const result = await completePersonalAccount(m.db, { link: m.link, body: { fullName: "Maya Chen", password: "correct horse" } });
    expect(result).toMatchObject({ ok: true, userId: "user-old", created: false });
    expect(provision.fn).not.toHaveBeenCalled();
    expect(spine.link).toHaveBeenCalledWith(expect.anything(), { userId: "user-old", phoneE164: PHONE });
  });

  it("an account with stronger credentials, or a phone two accounts claim, is sent to the ordinary sign-in and the link survives", async () => {
    const m = await minted();
    auth.owners.mockResolvedValue(["user-old"]);
    auth.allowed.mockResolvedValue(false);
    expect(await completePersonalAccount(m.db, { link: m.link, body: { fullName: "Maya Chen", password: "correct horse" } })).toMatchObject({ ok: false, status: 409, error: "Sign in to continue." });
    auth.owners.mockResolvedValue(["a", "b"]);
    expect(await completePersonalAccount(m.db, { link: m.link, body: { fullName: "Maya Chen", password: "correct horse" } })).toMatchObject({ ok: false, status: 409 });
    expect(spine.link).not.toHaveBeenCalled();
    expect(await resolvePhoneBoundLink(m.db, m.token, { count: false })).not.toBeNull();
  });

  it("a failed history link never undoes the account, and an invalid form gives the link back", async () => {
    const m = await minted();
    spine.link.mockRejectedValueOnce(new Error("prospect-spine: not built"));
    expect(await completePersonalAccount(m.db, { link: m.link, body: { fullName: "Maya Chen", password: "correct horse" } })).toMatchObject({ ok: true, created: true });
    const n = await minted();
    expect(await completePersonalAccount(n.db, { link: n.link, body: { fullName: "M" } })).toMatchObject({ ok: false, status: 400 });
    expect(await resolvePhoneBoundLink(n.db, n.token, { count: false })).not.toBeNull();
  });

  it("any other kind of link, or an unknown token, answers 'expired' to the account route", async () => {
    const m = await minted();
    const wrong = await accountRoute(req("x".repeat(43), { fullName: "Maya Chen", password: "correct horse" }), { params: Promise.resolve({ token: "x".repeat(43) }) });
    expect(wrong.status).toBe(404);
    m.rows.phone_bound_links![0]!.purpose = "tour";
    const tour = await accountRoute(req(m.token, { fullName: "Maya Chen", password: "correct horse" }), { params: Promise.resolve({ token: m.token }) });
    expect(tour.status).toBe(404);
    expect(provision.fn).not.toHaveBeenCalled();
  });

  it("validates the form: a name, a plausible optional email, a password (or Google)", () => {
    expect(validatePersonalAccountInput({ fullName: "M", password: "correct horse" })).toMatchObject({ ok: false });
    expect(validatePersonalAccountInput({ fullName: "Maya Chen", email: "nope", password: "correct horse" })).toMatchObject({ ok: false });
    expect(validatePersonalAccountInput({ fullName: "Maya Chen", password: "short" })).toMatchObject({ ok: false });
    expect(validatePersonalAccountInput({ fullName: " Maya  Chen ", email: " Maya@Example.com ", password: "correct horse" })).toEqual({
      ok: true,
      value: { fullName: "Maya Chen", email: "maya@example.com", password: "correct horse", viaGoogle: false },
    });
    expect(validatePersonalAccountInput({ fullName: "Maya Chen", provider: "google", password: "ignored" })).toEqual({
      ok: true,
      value: { fullName: "Maya Chen", email: "", password: "", viaGoogle: true },
    });
  });

  it("sets the password on a NEW account only, never on an existing one", async () => {
    const setPassword = vi.fn(async () => true);
    const m = await minted();
    await completePersonalAccount(m.db, { link: m.link, body: { fullName: "Maya Chen", password: "correct horse" } }, { setPassword, emailTaken: async () => false });
    expect(setPassword).toHaveBeenCalledWith(expect.anything(), "user-new", "correct horse");
    setPassword.mockClear();
    const n = await minted();
    auth.owners.mockResolvedValue(["user-old"]);
    await completePersonalAccount(n.db, { link: n.link, body: { fullName: "Maya Chen", password: "correct horse" } }, { setPassword });
    expect(setPassword).not.toHaveBeenCalled();
  });

  it("an email another account holds is never stored and the answer is the same: no existence oracle, no second account", async () => {
    const m = await minted();
    const taken = await completePersonalAccount(m.db, { link: m.link, body: { fullName: "Maya Chen", email: "held@example.com", password: "correct horse" } }, { emailTaken: async () => true });
    expect(taken).toMatchObject({ ok: true, created: true });
    expect(provision.fn.mock.calls[0]![1].answers).not.toHaveProperty("email");
    provision.fn.mockClear();
    const n = await minted();
    const free = await completePersonalAccount(n.db, { link: n.link, body: { fullName: "Maya Chen", email: "free@example.com", password: "correct horse" } }, { emailTaken: async () => false });
    expect({ ...taken, userId: 0, session: 0 }).toEqual({ ...free, userId: 0, session: 0 });
    expect(provision.fn.mock.calls[0]![1].answers).toMatchObject({ email: "free@example.com" });
    // An unreadable lookup behaves as taken (claim dropped), never as free.
    provision.fn.mockClear();
    const o = await minted();
    await completePersonalAccount(o.db, { link: o.link, body: { fullName: "Maya Chen", email: "x@example.com", password: "correct horse" } }, { emailTaken: async () => { throw new Error("down"); } });
    expect(provision.fn.mock.calls[0]![1].answers).not.toHaveProperty("email");
  });

  it("a new account's free email gets the proof mail; a taken one gets none and the answer is the same", async () => {
    const proof = vi.fn(async () => true);
    const m = await minted();
    await completePersonalAccount(m.db, { link: m.link, body: { fullName: "Maya Chen", email: "free@example.com", password: "correct horse" } }, { emailTaken: async () => false, sendEmailProof: proof });
    expect(proof).toHaveBeenCalledWith(expect.anything(), { userId: "user-new", email: "free@example.com" }, expect.anything());
    proof.mockClear();
    const n = await minted();
    await completePersonalAccount(n.db, { link: n.link, body: { fullName: "Maya Chen", email: "held@example.com", password: "correct horse" } }, { emailTaken: async () => true, sendEmailProof: proof });
    expect(proof).not.toHaveBeenCalled();
  });

  it("lands on the conversation and surfaces the asked-about home from the link (never from the request)", async () => {
    const m = await minted();
    const result = await completePersonalAccount(m.db, { link: m.link, body: { fullName: "Maya Chen", password: "correct horse", propertyId: "evil" } }, { emailTaken: async () => false });
    expect(result).toMatchObject({ ok: true, nextPath: "/resident/communication" });
    expect((result as { propertyPath: string }).propertyPath).toContain("propertyId=prop-1");
    const bare = await minted(null);
    expect(await completePersonalAccount(bare.db, { link: bare.link, body: { fullName: "Maya Chen", password: "correct horse" } }, { emailTaken: async () => false })).toMatchObject({ ok: true, propertyPath: null });
  });
});

describe("Text us", () => {
  it("the body names the home and room in plain GSM-7 and ends with the entry code in parentheses", () => {
    const body = textUsBody({ label: "5259 Brooklyn Ave NE", roomLabel: "Room 4", code: "brooklyn5" });
    expect(body).toBe("Hi, I'm interested in 5259 Brooklyn Ave NE, Room 4. (BROOKLYN5)");
    expect(textUsBody({ label: "Row “B” — Unit", code: null })).not.toMatch(/[“”—]/);
    expect(textUsBody({ label: "5259 Brooklyn", code: null })).toBe("Hi, I'm interested in 5259 Brooklyn.");
    expect(textUsBody({ label: "5259 Brooklyn", code: "not a code!" })).not.toContain("(");
  });

  it("the href is the sms: form for the ONE number given, and empty for anything that is not a number", () => {
    const href = textUsHref("+12066781909", "Hi there (CODE1)");
    expect(href).toBe("sms:+12066781909?&body=Hi%20there%20(CODE1)");
    expect(href.startsWith("sms:+12066781909?&body=")).toBe(true);
    expect(textUsHref("", "x")).toBe("");
    expect(textUsHref("not a number", "x")).toBe("");
  });
});
