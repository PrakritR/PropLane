// "Text me a link" for a renter with no account (captain, Nov 14): a single-use phone-bound link whose first open IS the
// phone proof. Hash only at rest, short-lived, never carries the application, rate limited, existing account signed in
// (never a second one), and the held draft is claimable by the verified phone afterwards.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));
const rate = vi.hoisted(() => ({ ok: true, keys: [] as string[] }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async (key: string) => {
    rate.keys.push(key);
    return { ok: rate.ok };
  }),
  clientIpFrom: () => "203.0.113.9",
}));
const auth = vi.hoisted(() => ({ owners: vi.fn(), mint: vi.fn(), allowed: vi.fn() }));
vi.mock("@/lib/auth/phone-auth.server", () => ({ phoneOwners: auth.owners, mintPhoneSession: auth.mint }));
vi.mock("@/lib/auth/sms-proven-session.server", () => ({ smsProvenSessionAllowed: auth.allowed }));
const provision = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/one-number/signup/provision.server", () => ({ provisionSmsSignupAccount: provision.fn }));
const spine = vi.hoisted(() => ({ link: vi.fn(async () => ({ linked: true, threads: 1 })) }));
vi.mock("@/lib/prospect-spine/index.server", () => ({ linkAccountToProspectRecord: spine.link, recordInbound: vi.fn() }));
const sms = vi.hoisted(() => ({ send: vi.fn(async () => true) }));
vi.mock("@/lib/one-number/link-text.server", () => ({ sendWorkspacePhoneText: sms.send, roleForLinkPurpose: () => "prospect" }));
const WS = "11111111-1111-1111-1111-111111111111";
const PHONE = "+12065550142";
const PHONE_KEY = "2065550142";
const listing = vi.hoisted(() => ({ value: null as null | Record<string, string> }));
vi.mock("@/lib/tour-guest-prospect.server", () => ({ loadGuestTourListing: vi.fn(async () => listing.value) }));
const tours = vi.hoisted(() => ({ inquiry: null as null | Record<string, unknown>, link: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/tour-resident-link.server", () => ({ loadTourInquiryById: vi.fn(async () => tours.inquiry), linkTourInquiryToResident: tours.link }));
const serviceDb = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => serviceDb.db }));
const sessionClient = vi.hoisted(() => ({ setSession: vi.fn(async () => ({})), user: null as null | { id: string } }));
vi.mock("@/lib/supabase/server", () => ({
  createRealIdentitySupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: sessionClient.user } }), setSession: sessionClient.setSession } }),
}));

import { POST as completeRoute } from "@/app/api/l/[token]/guest-signup/route";
import { POST as accountRoute } from "@/app/api/l/[token]/account/route";
import { POST as sendRoute } from "@/app/api/public/guest-signup-link/route";
import { completeGuestSignup, openGuestSignupLink } from "@/lib/guest-signup-link/complete.server";
import { guestSignupLandingPath, guestSignupTargetId, GUEST_APPLY_LINK_TARGET } from "@/lib/guest-signup-link/model";
import { sendGuestSignupLink } from "@/lib/guest-signup-link/send.server";
import { hashGuestDraftToken, claimGuestApplicationDraft } from "@/lib/rental-application/guest-draft.server";
import { resolvePhoneBoundLink, type PhoneBoundLink } from "@/lib/one-number/links.server";
import { linksFakeDb } from "../helpers/links-fake-db";

const DRAFT_TOKEN = "A".repeat(43);

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  const fake = linksFakeDb({
    portal_workspaces: [{ id: WS, owner_user_id: "owner-1" }],
    guest_application_drafts: [
      { id: "d1", token_hash: hashGuestDraftToken(DRAFT_TOKEN), property_id: "prop-1", phone_e164: PHONE, email: "r@example.com", status: "pending", expires_at: new Date(Date.now() + 3600_000).toISOString(), created_at: new Date().toISOString(), draft: { fullLegalName: "Riley Renter" } },
    ],
    ...extra,
  });
  (fake.db as unknown as { auth: unknown }).auth = {
    admin: { getUserById: async (id: string) => ({ data: { user: { id, user_metadata: {} } }, error: null }), updateUserById: async () => ({ data: {}, error: null }) },
  };
  serviceDb.db = fake.db;
  return fake;
}

async function sentLink(kind: "apply" | "tour" = "apply") {
  const fake = seed();
  const result = await sendGuestSignupLink(fake.db, kind === "apply" ? { kind: "apply", draftToken: DRAFT_TOKEN } : { kind: "tour", tourInquiryId: "inq-1" });
  const body = (sms.send.mock.calls.at(-1)?.[1] as { body: string } | undefined)?.body ?? "";
  const token = /\/l\/(\S+)$/m.exec(body)?.[1] ?? "";
  const link = token ? (await resolvePhoneBoundLink(fake.db, token, { count: false }))?.link ?? null : null;
  return { ...fake, result, token, body, link: link as PhoneBoundLink };
}

const completeReq = (token: string) => new Request(`https://proplane.test/api/l/${token}/guest-signup`, { method: "POST" });
const params = (token: string) => ({ params: Promise.resolve({ token }) });

beforeEach(() => {
  rate.ok = true;
  rate.keys = [];
  listing.value = { propertyId: "prop-1", workspaceId: WS, ownerUserId: "owner-1", propertyLabel: "5259 Brooklyn", roomId: "", roomLabel: "" };
  tours.inquiry = { id: "inq-1", kind: "tour", guestTour: true, smsConsent: true, phone: PHONE, email: "r@example.com", name: "Riley Renter", propertyId: "prop-1" };
  tours.link.mockClear();
  sms.send.mockReset().mockResolvedValue(true);
  auth.owners.mockReset().mockResolvedValue([]);
  auth.allowed.mockReset().mockResolvedValue(true);
  auth.mint.mockReset().mockResolvedValue({ access_token: "a", refresh_token: "r" });
  provision.fn.mockReset().mockResolvedValue({ ok: true, userId: "user-new", email: "x@phone.proplane.invalid" });
  spine.link.mockClear();
  sessionClient.setSession.mockClear();
  sessionClient.user = null;
});

describe("sending the link", () => {
  it("texts the draft's own phone a link: hash only at rest, 2 hours, no code gate, never the application", async () => {
    const s = await sentLink();
    expect(s.result).toEqual({ ok: true });
    expect(sms.send).toHaveBeenCalledTimes(1);
    const call = sms.send.mock.calls[0]![1] as { phoneKey: string; workspaceId: string; basis: unknown; body: string };
    expect(call).toMatchObject({ phoneKey: PHONE, workspaceId: WS, basis: { kind: "code" } });
    expect(call.body).not.toContain("Riley");
    expect(call.body).not.toContain("example.com");
    expect(s.link).toMatchObject({ phoneKey: PHONE_KEY, purpose: "account", targetType: GUEST_APPLY_LINK_TARGET, targetId: guestSignupTargetId(WS, "prop-1"), requiresOtp: false });
    const hours = (Date.parse(s.link.expiresAt!) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(1.9);
    expect(hours).toBeLessThanOrEqual(2.01);
    expect(JSON.stringify(s.rows.phone_bound_links)).not.toContain(s.token);
  });

  it("refuses a draft token that is malformed, unknown, expired or phone-less, and never texts", async () => {
    const fake = seed();
    expect(await sendGuestSignupLink(fake.db, { kind: "apply", draftToken: "short" })).toMatchObject({ ok: false, status: 400 });
    expect(await sendGuestSignupLink(fake.db, { kind: "apply", draftToken: "B".repeat(43) })).toMatchObject({ ok: false, status: 404 });
    fake.rows.guest_application_drafts![0]!.expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await sendGuestSignupLink(fake.db, { kind: "apply", draftToken: DRAFT_TOKEN })).toMatchObject({ ok: false });
    fake.rows.guest_application_drafts![0]!.expires_at = new Date(Date.now() + 3600_000).toISOString();
    fake.rows.guest_application_drafts![0]!.phone_e164 = null;
    expect(await sendGuestSignupLink(fake.db, { kind: "apply", draftToken: DRAFT_TOKEN })).toMatchObject({ ok: false, status: 404 });
    expect(sms.send).not.toHaveBeenCalled();
  });

  it("a tour link is capped per workspace; an application link is not", async () => {
    const fake = seed();
    rate.keys.length = 0;
    await sendGuestSignupLink(fake.db, { kind: "tour", tourInquiryId: "inq-1" });
    expect(rate.keys.some((k) => k.startsWith("guest-signup-link-tour-ws:"))).toBe(true);
    rate.keys.length = 0;
    await sendGuestSignupLink(fake.db, { kind: "apply", draftToken: DRAFT_TOKEN });
    expect(rate.keys.some((k) => k.startsWith("guest-signup-link-tour-ws:"))).toBe(false);
  });

  it("a tour link needs a guest tour that ticked the SMS box", async () => {
    const fake = seed();
    tours.inquiry = { ...tours.inquiry!, smsConsent: false };
    expect(await sendGuestSignupLink(fake.db, { kind: "tour", tourInquiryId: "inq-1" })).toMatchObject({ ok: false });
    tours.inquiry = { ...tours.inquiry!, smsConsent: true, guestTour: false };
    expect(await sendGuestSignupLink(fake.db, { kind: "tour", tourInquiryId: "inq-1" })).toMatchObject({ ok: false });
    expect(sms.send).not.toHaveBeenCalled();
    tours.inquiry = { ...tours.inquiry!, guestTour: true };
    expect(await sendGuestSignupLink(fake.db, { kind: "tour", tourInquiryId: "inq-1" })).toEqual({ ok: true });
  });

  it("is rate limited per phone and per subject, and the route per IP", async () => {
    const fake = seed();
    rate.ok = false;
    expect(await sendGuestSignupLink(fake.db, { kind: "apply", draftToken: DRAFT_TOKEN })).toMatchObject({ ok: false, status: 429 });
    expect(rate.keys.some((k) => k.startsWith("guest-signup-link-phone:"))).toBe(true);
    expect(sms.send).not.toHaveBeenCalled();
    const res = await sendRoute(new Request("https://proplane.test/api/public/guest-signup-link", { method: "POST", body: JSON.stringify({ kind: "apply", draftToken: DRAFT_TOKEN }) }));
    expect(res.status).toBe(429);
    expect(rate.keys.some((k) => k.startsWith("guest-signup-link-ip:"))).toBe(true);
  });

  it("a text that could not leave leaves no live link (STOP, quiet hours, no line)", async () => {
    const fake = seed();
    sms.send.mockResolvedValue(false);
    expect(await sendGuestSignupLink(fake.db, { kind: "apply", draftToken: DRAFT_TOKEN })).toMatchObject({ ok: false, status: 502 });
    expect(fake.rows.phone_bound_links!.every((l) => l.revoked_at)).toBe(true);
  });

  it("the route never takes a phone from the request and answers a bad kind with a generic 400", async () => {
    seed();
    const res = await sendRoute(new Request("https://proplane.test/api/public/guest-signup-link", { method: "POST", body: JSON.stringify({ kind: "nope", phone: "+12065559999" }) }));
    expect(res.status).toBe(400);
    expect(sms.send).not.toHaveBeenCalled();
    const ok = await sendRoute(new Request("https://proplane.test/api/public/guest-signup-link", { method: "POST", body: JSON.stringify({ kind: "apply", draftToken: DRAFT_TOKEN, phone: "+12065559999" }) }));
    expect(ok.status).toBe(200);
    expect((sms.send.mock.calls[0]![1] as { phoneKey: string }).phoneKey).toBe(PHONE);
  });
});

describe("opening and finishing the link", () => {
  it("the page data names the home and a masked phone, never the full number or the draft", async () => {
    const s = await sentLink();
    const opened = await openGuestSignupLink(s.db, s.link);
    expect(opened).toEqual({ ok: true, houseLabel: "5259 Brooklyn", maskedPhone: "•••• 0142", kind: "apply" });
    expect(JSON.stringify(opened)).not.toContain(PHONE_KEY);
  });

  it("creates the account for the link's phone (named from the held draft), links the phone, mints a session, lands on the apply page", async () => {
    const s = await sentLink();
    const res = await completeRoute(completeReq(s.token), params(s.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, signedIn: true, nextPath: "/resident/applications/apply?propertyId=prop-1" });
    expect(provision.fn.mock.calls[0]![1]).toMatchObject({ phoneE164: PHONE, role: "resident", answers: { fullName: "Riley Renter" } });
    expect(spine.link).toHaveBeenCalledWith(expect.anything(), { userId: "user-new", phoneE164: PHONE });
    expect(sessionClient.setSession).toHaveBeenCalledTimes(1);
  });

  it("is single use: a second open reads as expired", async () => {
    const s = await sentLink();
    expect((await completeRoute(completeReq(s.token), params(s.token))).status).toBe(200);
    const again = await completeRoute(completeReq(s.token), params(s.token));
    expect(again.status).toBe(404);
    expect(provision.fn).toHaveBeenCalledTimes(1);
  });

  it("an expired, revoked or unknown token answers the same expired message, and the personal-account route refuses a guest link", async () => {
    const s = await sentLink();
    s.rows.phone_bound_links![0]!.expires_at = new Date(Date.now() - 1000).toISOString();
    const expired = await completeRoute(completeReq(s.token), params(s.token));
    expect(expired.status).toBe(404);
    expect(await expired.json()).toEqual({ error: "This link has expired." });
    const unknown = await completeRoute(completeReq("Z".repeat(43)), params("Z".repeat(43)));
    expect(unknown.status).toBe(404);
    const fresh = await sentLink();
    const viaAccount = await accountRoute(new Request("https://proplane.test/x", { method: "POST", body: JSON.stringify({ fullName: "Riley Renter", email: "", password: "longenough1" }) }), params(fresh.token));
    expect(viaAccount.status).toBe(404);
    expect(provision.fn).not.toHaveBeenCalled();
  });

  it("a link whose home is no longer a live listing of its workspace is refused and not spent", async () => {
    const s = await sentLink();
    listing.value = { ...listing.value!, workspaceId: "22222222-2222-2222-2222-222222222222" };
    const res = await completeRoute(completeReq(s.token), params(s.token));
    expect(res.status).toBe(404);
    expect(s.rows.phone_bound_links![0]!.used_at).toBeNull();
  });

  it("an account already holding this verified phone is signed in, never a second account", async () => {
    auth.owners.mockResolvedValue(["user-existing"]);
    const s = await sentLink();
    const res = await completeRoute(completeReq(s.token), params(s.token));
    expect(res.status).toBe(200);
    expect(provision.fn).not.toHaveBeenCalled();
    expect(spine.link).toHaveBeenCalledWith(expect.anything(), { userId: "user-existing", phoneE164: PHONE });
    expect(auth.mint).toHaveBeenCalled();
  });

  it("an existing account a phone must not open (manager, admin) is sent to the ordinary sign-in and the link is given back", async () => {
    auth.owners.mockResolvedValue(["user-existing"]);
    auth.allowed.mockResolvedValue(false);
    const s = await sentLink();
    const res = await completeRoute(completeReq(s.token), params(s.token));
    expect(res.status).toBe(409);
    expect(auth.mint).not.toHaveBeenCalled();
    expect(s.rows.phone_bound_links![0]!.used_at).toBeNull();
  });

  it("two holders of the phone is ambiguous: sign in, nothing created", async () => {
    auth.owners.mockResolvedValue(["a", "b"]);
    const s = await sentLink();
    expect((await completeRoute(completeReq(s.token), params(s.token))).status).toBe(409);
    expect(provision.fn).not.toHaveBeenCalled();
  });

  it("a failed provision gives the link back so the renter can try again", async () => {
    provision.fn.mockResolvedValue({ ok: false, reason: "unavailable" });
    const s = await sentLink();
    expect((await completeRoute(completeReq(s.token), params(s.token))).status).toBe(503);
    expect(s.rows.phone_bound_links![0]!.used_at).toBeNull();
  });

  it("another account's open session is never replaced", async () => {
    sessionClient.user = { id: "someone-else" };
    const s = await sentLink();
    const body = await (await completeRoute(completeReq(s.token), params(s.token))).json();
    expect(body.signedIn).toBe(false);
    expect(sessionClient.setSession).not.toHaveBeenCalled();
  });

  it("a tour link links the tour to the account and lands on Tour", async () => {
    const s = await sentLink("tour");
    expect(s.link.targetType).toBe("guest_tour");
    const done = await completeGuestSignup(s.db, { link: s.link });
    expect(done).toMatchObject({ ok: true, created: true, nextPath: "/resident/tour", kind: "tour" });
    expect(tours.link).toHaveBeenCalledWith(expect.anything(), { userId: "user-new", inquiryId: "inq-1", email: "r@example.com" });
    expect(guestSignupLandingPath("tour", "inq-1")).toBe("/resident/tour");
  });

  it("after the link, the draft is claimable by the verified phone (and by nothing else)", async () => {
    const s = await sentLink();
    await completeRoute(completeReq(s.token), params(s.token));
    const wrong = await claimGuestApplicationDraft(s.db, { userId: "user-new", contact: { email: null, phoneE164: "+12065550999" }, propertyId: "prop-1" });
    expect(wrong).toEqual({ ok: false, reason: "none" });
    const claimed = await claimGuestApplicationDraft(s.db, { userId: "user-new", contact: { email: null, phoneE164: PHONE }, propertyId: "prop-1" });
    expect(claimed).toMatchObject({ ok: true, propertyId: "prop-1" });
  });
});
