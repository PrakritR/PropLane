import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  db: null as unknown,
  cookies: {} as Record<string, string>,
  send: vi.fn(),
  checkout: vi.fn(),
  achStatus: vi.fn(),
  achVerify: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => state.db }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (state.cookies[name] ? { value: state.cookies[name] } : undefined) }),
}));
vi.mock("@/lib/one-number/link-text.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/one-number/link-text.server")>()),
  sendWorkspacePhoneText: state.send,
}));
vi.mock("@/lib/resident-ach-payment.server", () => ({
  residentAchStatusResponse: state.achStatus,
  residentAchVerifyResponse: state.achVerify,
}));
vi.mock("@/lib/stripe-household-charge-checkout.server", () => ({ createHouseholdChargeCheckout: state.checkout }));
vi.mock("@/lib/app-url", async (orig) => ({
  ...(await orig<typeof import("@/lib/app-url")>()),
  resolveAppOrigin: () => "https://proplane.test",
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));

import { POST as codeRoute } from "@/app/api/l/[token]/code/route";
import { POST as rentRoute } from "@/app/api/l/[token]/rent-checkout/route";
import { GET as bankGet, POST as bankPost } from "@/app/api/l/[token]/bank-payment/route";
import { POST as bindRoute } from "@/app/api/public/phone-bind/route";
import { createLinkSession, linkSessionCookieName, mintPhoneBoundLink, resolvePhoneBoundLink } from "@/lib/one-number/links.server";
import { linksFakeDb } from "../helpers/links-fake-db";

const WS = "ws-a";
let counter = 0;
const call = <T>(route: (req: Request, ctx: { params: Promise<{ token: string }> }) => Promise<T>, token: string, body: unknown, ip = `10.0.0.${++counter}`) =>
  route(
    new Request("http://x/api", { method: "POST", headers: { "x-forwarded-for": ip }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ token }) },
  );

function world() {
  const fake = linksFakeDb({
    portal_workspaces: [{ id: WS, owner_user_id: "owner-a", is_default: true }],
    manager_property_records: [{ id: "prop-1", workspace_id: WS, manager_user_id: "owner-a" }],
    profiles: [{ id: "res-1", phone: "2065550142", phone_verified_at: "2026-09-01T00:00:00Z" }],
    portal_household_charge_records: [{
      id: "chg-1", status: "pending",
      row_data: { id: "chg-1", residentUserId: "res-1", residentEmail: "res@example.com", propertyId: "prop-1", title: "Rent", amountLabel: "$100.00", balanceLabel: "$100.00", propertyLabel: "X", status: "pending" },
    }],
    sms_entry_codes: [{ code: "BROOKLYN5", workspace_id: WS, owner_user_id: "owner-a", property_id: "prop-1", active: true }],
  });
  state.db = fake.db;
  return fake;
}

async function mint(db: never, purpose: "application" | "rent" | "gallery", targetType = "listing", targetId = "prop-1", phoneKey = `20655510${String(10 + ++counter).padStart(2, "0")}`) {
  const minted = await mintPhoneBoundLink(db, { phoneKey, workspaceId: WS, purpose, targetType, targetId, origin: "https://proplane.test" });
  const link = (await resolvePhoneBoundLink(db, minted.token, { count: false }))!.link;
  return { ...minted, link, phoneKey };
}

beforeEach(() => {
  state.cookies = {};
  state.send.mockReset();
  state.send.mockResolvedValue(true);
  state.checkout.mockReset();
  state.achStatus.mockReset();
  state.achVerify.mockReset();
});

describe("POST /api/l/[token]/code", () => {
  it("answers an unknown token, a malformed one and a link with no code step identically", async () => {
    const { db } = world();
    const noCode = await mint(db, "gallery");
    const answers = await Promise.all([
      call(codeRoute, "A".repeat(43), { action: "send" }),
      call(codeRoute, "short", { action: "send" }),
      call(codeRoute, noCode.token, { action: "send" }),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "This link has expired." });
    }
    expect(state.send).not.toHaveBeenCalled();
  });

  it("send texts the code to the link's own phone and nobody else", async () => {
    const { db } = world();
    const { token, phoneKey } = await mint(db, "application");
    const res = await call(codeRoute, token, { action: "send", phone: "2069999999", to: "2069999999" });
    expect(res.status).toBe(200);
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0]![1]).toMatchObject({ phoneKey, workspaceId: WS });
  });

  it("verify sets an httpOnly session cookie scoped to the link; a wrong code does not", async () => {
    const { db } = world();
    const { token } = await mint(db, "application");
    await call(codeRoute, token, { action: "send" });
    const code = /\b(\d{6})\b/.exec((state.send.mock.calls[0]![1] as { body: string }).body)![1]!;
    const wrong = code === "000000" ? "111111" : "000000";

    const bad = await call(codeRoute, token, { action: "verify", code: wrong });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("set-cookie")).toBeNull();

    const good = await call(codeRoute, token, { action: "verify", code });
    expect(good.status).toBe(200);
    const cookie = good.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${linkSessionCookieName(token)}=`);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    expect(cookie).toMatch(/Max-Age=60(4799|4800)/i); // 7 days
  });

  it("locks after five wrong codes with a 429", async () => {
    const { db } = world();
    const { token } = await mint(db, "application");
    await call(codeRoute, token, { action: "send" });
    const code = /\b(\d{6})\b/.exec((state.send.mock.calls[0]![1] as { body: string }).body)![1]!;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i += 1) expect((await call(codeRoute, token, { action: "verify", code: wrong })).status).toBe(400);
    expect((await call(codeRoute, token, { action: "verify", code })).status).toBe(429);
  });

  it("a fourth code request in an hour is a 429, and a failed text is a 502", async () => {
    const { db } = world();
    const { token } = await mint(db, "application");
    for (let i = 0; i < 3; i += 1) expect((await call(codeRoute, token, { action: "send" })).status).toBe(200);
    expect((await call(codeRoute, token, { action: "send" })).status).toBe(429);
    const fresh = await mint(db, "application", "listing", "prop-1");
    state.send.mockResolvedValueOnce(false);
    expect((await call(codeRoute, fresh.token, { action: "send" })).status).toBe(502);
  });

  it("rejects an unknown action", async () => {
    const { db } = world();
    const { token } = await mint(db, "application");
    expect((await call(codeRoute, token, { action: "other" })).status).toBe(400);
  });
});

describe("POST /api/l/[token]/rent-checkout", () => {
  async function rentLink() {
    const { db } = world();
    const minted = await mint(db, "rent", "charge", "chg-1", "2065550142");
    return { db, ...minted };
  }

  it("needs a verified session on this link", async () => {
    const { token } = await rentLink();
    const res = await call(rentRoute, token, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ needsCode: true });
    expect(state.checkout).not.toHaveBeenCalled();
  });

  it("another link's session does not work", async () => {
    const { db, token } = await rentLink();
    const other = await mint(db, "rent", "charge", "chg-1", "2065550999");
    const session = (await createLinkSession(db, other.link))!;
    state.cookies[linkSessionCookieName(token)] = session.token;
    expect((await call(rentRoute, token, {})).status).toBe(401);
  });

  it("starts card checkout for the live charge, as that charge's resident, returning to this link", async () => {
    const { db, token, link } = await rentLink();
    const session = (await createLinkSession(db, link))!;
    state.cookies[linkSessionCookieName(token)] = session.token;
    state.checkout.mockResolvedValue({ ok: true, mode: "embedded", clientSecret: "cs_test_secret_1" });

    const res = await call(rentRoute, token, { chargeIds: ["chg-someone-elses"], userId: "attacker", paymentMethod: "ach" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clientSecret: "cs_test_secret_1" });
    // Nothing from the body reached the checkout core.
    expect(state.checkout).toHaveBeenCalledTimes(1);
    expect(state.checkout.mock.calls[0]![1]).toMatchObject({
      userId: "res-1", userEmail: "res@example.com", chargeIds: ["chg-1"], mode: "embedded", paymentMethod: "card",
      appOrigin: "https://proplane.test", returnPath: `/l/${encodeURIComponent(token)}`,
    });
  });

  it("a session on a link whose phone no longer matches the resident is refused", async () => {
    const fake = world();
    const minted = await mint(fake.db, "rent", "charge", "chg-1", "2065550142");
    const session = (await createLinkSession(fake.db, minted.link))!;
    state.cookies[linkSessionCookieName(minted.token)] = session.token;
    // The account's phone changed after the link was issued: the destination re-derivation fails closed.
    fake.rows.profiles![0]!.phone = "2069990000";
    const res = await call(rentRoute, minted.token, {});
    expect(res.status).toBe(404);
    expect(state.checkout).not.toHaveBeenCalled();
  });

  it("maps a checkout failure to its status without leaking internals", async () => {
    const { db, token, link } = await rentLink();
    const session = (await createLinkSession(db, link))!;
    state.cookies[linkSessionCookieName(token)] = session.token;
    state.checkout.mockResolvedValue({ ok: false, status: 500, error: "relation public.secret does not exist" });
    const res = await call(rentRoute, token, {});
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("relation");

    state.checkout.mockResolvedValue({ ok: false, status: 422, code: "PAYMENT_METHOD_DISABLED", error: "x" });
    const card = await call(rentRoute, token, {});
    expect(card.status).toBe(422);
    expect(await card.json()).toMatchObject({ signInHref: "/auth/sign-in?next=%2Fresident%2Fpayments" });
  });
});

describe("bank (ACH) on a rent link", () => {
  async function verifiedLink() {
    const { db } = world();
    const minted = await mint(db, "rent", "charge", "chg-1", "2065550142");
    const session = (await createLinkSession(db, minted.link))!;
    state.cookies[linkSessionCookieName(minted.token)] = session.token;
    return { ...minted, db };
  }

  it("starts a bank payment through the same checkout core and returns only what the in-page form needs", async () => {
    const { token } = await verifiedLink();
    state.checkout.mockResolvedValue({ ok: true, mode: "manual_ach", clientSecret: "pi_secret", paymentIntentId: "pi_1", bankStatus: "entry", totalCents: 10150 });
    const res = await call(rentRoute, token, { method: "bank", chargeIds: ["other"], userId: "attacker" });
    expect(await res.json()).toEqual({ bank: { clientSecret: "pi_secret", paymentIntentId: "pi_1", bankStatus: "entry", totalCents: 10150 } });
    expect(state.checkout.mock.calls[0]![1]).toMatchObject({ userId: "res-1", chargeIds: ["chg-1"], paymentMethod: "ach", mode: "embedded" });
  });

  it("a charge that does not accept a bank debit says so without sending the payer anywhere", async () => {
    const { token } = await verifiedLink();
    state.checkout.mockResolvedValue({ ok: false, status: 422, code: "PAYMENT_METHOD_DISABLED", error: "x" });
    const res = await call(rentRoute, token, { method: "bank" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Bank payment is not available for this charge. Pay by card instead." });
  });

  it("the status read and the verification need this link's verified session, and act as the resident the charge names", async () => {
    const { token, db, link } = await verifiedLink();
    delete state.cookies[linkSessionCookieName(token)];
    const get = (t: string) => bankGet(new Request(`http://x/api?payment_intent_id=pi_1`, { headers: { "x-forwarded-for": `10.2.0.${++counter}` } }), { params: Promise.resolve({ token: t }) });
    expect((await get(token)).status).toBe(401);
    expect(state.achStatus).not.toHaveBeenCalled();

    const session = (await createLinkSession(db, link))!;
    state.cookies[linkSessionCookieName(token)] = session.token;
    state.achStatus.mockResolvedValue(new Response(JSON.stringify({ bankStatus: "entry" }), { status: 200 }));
    expect((await get(token)).status).toBe(200);
    expect(state.achStatus).toHaveBeenCalledWith("pi_1", "res-1");

    state.achVerify.mockResolvedValue(new Response(JSON.stringify({ bankStatus: "clearing" }), { status: 200 }));
    expect((await call(bankPost, token, { paymentIntentId: "pi_1", descriptorCode: "SMABCD" })).status).toBe(200);
    expect(state.achVerify.mock.calls[0]![1]).toBe("res-1");
  });

  it("a gallery link or a phone that no longer matches the resident reaches nothing", async () => {
    const { db } = world();
    const gallery = await mint(db, "gallery");
    expect((await call(bankPost, gallery.token, {})).status).toBe(404);
    const fake = world();
    const minted = await mint(fake.db, "rent", "charge", "chg-1", "2065550142");
    const session = (await createLinkSession(fake.db, minted.link))!;
    state.cookies[linkSessionCookieName(minted.token)] = session.token;
    fake.rows.profiles![0]!.phone = "2069990000";
    expect((await call(bankPost, minted.token, {})).status).toBe(404);
    expect(state.achVerify).not.toHaveBeenCalled();
  });
});

describe("POST /api/public/phone-bind", () => {
  const bind = (body: unknown, ip = `10.1.0.${++counter}`) =>
    bindRoute(new Request("http://x/api/public/phone-bind", { method: "POST", headers: { "x-forwarded-for": ip }, body: JSON.stringify(body) }));

  it("an unknown or inactive code is a 404 with one message", async () => {
    world();
    for (const code of ["NOPE", "bad code", ""]) {
      const res = await bind({ code, kind: "apply", action: "send", phone: "2065550142" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "This link is not active." });
    }
    expect((await bind({ code: "BROOKLYN5", kind: "bogus", action: "send", phone: "2065550142" })).status).toBe(404);
  });

  it("send then verify binds the phone and sets the session cookie on the new link", async () => {
    const fake = world();
    expect((await bind({ code: "brooklyn5", kind: "apply", action: "send", phone: "(206) 555-0177" })).status).toBe(200);
    expect(state.send.mock.calls[0]![1]).toMatchObject({ phoneKey: "2065550177", workspaceId: WS });
    const code = /\b(\d{6})\b/.exec((state.send.mock.calls[0]![1] as { body: string }).body)![1]!;

    const res = await bind({ code: "brooklyn5", kind: "apply", action: "verify", phone: "2065550177", otp: code });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { href: string };
    expect(body.href).toMatch(/^\/l\/[A-Za-z0-9_-]{43}$/);
    const token = body.href.slice(3);
    expect(res.headers.get("set-cookie")).toContain(`${linkSessionCookieName(token)}=`);
    expect(fake.rows.phone_bound_links).toHaveLength(1);
    expect(fake.rows.phone_bound_links![0]).toMatchObject({ phone_key: "2065550177", purpose: "application" });
  });

  it("rejects a non-US phone and a wrong code", async () => {
    world();
    expect((await bind({ code: "BROOKLYN5", kind: "tour", action: "send", phone: "123" })).status).toBe(400);
    await bind({ code: "BROOKLYN5", kind: "tour", action: "send", phone: "2065550188" });
    const code = /\b(\d{6})\b/.exec((state.send.mock.calls.at(-1)![1] as { body: string }).body)![1]!;
    const wrong = code === "000000" ? "111111" : "000000";
    const res = await bind({ code: "BROOKLYN5", kind: "tour", action: "verify", phone: "2065550188", otp: wrong });
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
