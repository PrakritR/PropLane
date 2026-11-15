import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A guest applies with NO account (captain, Nov 14). The finished application is held under an unguessable token
 * (SHA-256 only at rest, 24 h), and only a verified phone / confirmed email can claim it. No account is created by
 * any of this: the draft routes never touch Auth's admin API.
 */

type Row = Record<string, unknown>;
let rows: Row[] = [];
let authAdminTouched = false;

function makeDb() {
  const state = { filters: [] as Array<[string, string, unknown]>, mode: "select" as "select" | "update", patch: {} as Row, orderDesc: false, max: 100 };
  const matches = (row: Row) =>
    state.filters.every(([op, col, value]) => {
      if (op === "eq") return row[col] === value;
      if (op === "gt") return String(row[col]) > String(value);
      return true;
    });
  const chain: Record<string, unknown> = {
    insert: (record: Row) => {
      const row = { id: `draft-${rows.length + 1}`, claimed_by_user_id: null, claimed_at: null, ...record };
      rows.push(row);
      return { select: () => ({ single: async () => ({ data: { id: row.id }, error: null }) }) };
    },
    select: () => chain,
    update: (patch: Row) => {
      state.mode = "update";
      state.patch = patch;
      return chain;
    },
    eq: (col: string, value: unknown) => (state.filters.push(["eq", col, value]), chain),
    gt: (col: string, value: unknown) => (state.filters.push(["gt", col, value]), chain),
    order: () => chain,
    limit: (n: number) => ((state.max = n), chain),
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) => {
      const hit = rows.filter(matches).slice(0, state.max);
      if (state.mode === "update") hit.forEach((row) => Object.assign(row, state.patch));
      return resolve({ data: hit.map((row) => ({ ...row })), error: null });
    },
  };
  return {
    from: () => chain,
    rpc: async () => ({ data: 0, error: null }),
    auth: { admin: new Proxy({}, { get: () => { authAdminTouched = true; return vi.fn(); } }) },
  };
}

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));
vi.mock("@/lib/tour-guest-prospect.server", () => ({
  loadGuestTourListing: vi.fn(async (_db: unknown, id: string) => (id === "prop-1" ? { propertyId: "prop-1" } : null)),
}));
const rateLimit = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: (...a: unknown[]) => rateLimit(...a), clientIpFrom: () => "203.0.113.7" }));
const getUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createRealIdentitySupabaseServerClient: async () => ({ auth: { getUser: () => getUser() } }) }));
const readPhoneIdentity = vi.fn();
vi.mock("@/lib/auth/phone-auth.server", () => ({ readPhoneIdentity: (...a: unknown[]) => readPhoneIdentity(...a) }));

import {
  GUEST_DRAFT_TTL_MS,
  claimGuestApplicationDraft,
  hashGuestDraftToken,
  isWellFormedGuestDraftToken,
  mintGuestDraftToken,
  parseGuestDraftRequest,
  stashGuestApplicationDraft,
} from "@/lib/rental-application/guest-draft.server";
import { POST as stashRoute } from "@/app/api/public/application-drafts/route";
import { POST as claimRoute } from "@/app/api/resident/application-drafts/claim/route";

const form = { fullLegalName: "Jordan Guest", email: "Jordan@Example.test", phone: "(206) 555-0142", propertyId: "prop-1", ssn: "000-00-0000" };
const jsonReq = (path: string, body: unknown) => new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

beforeEach(() => {
  rows = [];
  authAdminTouched = false;
  rateLimit.mockReset();
  rateLimit.mockResolvedValue({ ok: true });
  getUser.mockReset();
  readPhoneIdentity.mockReset();
});

describe("draft token", () => {
  it("is unguessable, well formed, and stored only as its SHA-256", async () => {
    const token = mintGuestDraftToken();
    expect(isWellFormedGuestDraftToken(token)).toBe(true);
    expect(isWellFormedGuestDraftToken("short")).toBe(false);
    expect(mintGuestDraftToken()).not.toBe(token);
    expect(hashGuestDraftToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashGuestDraftToken(token)).not.toContain(token);

    const parsed = parseGuestDraftRequest({ propertyId: "prop-1", form });
    if (!parsed.ok) throw new Error("parse failed");
    const stashed = await stashGuestApplicationDraft(makeDb() as never, parsed.value, new Date("2026-11-14T10:00:00Z"));
    if (!stashed.ok) throw new Error("stash failed");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hashGuestDraftToken(stashed.token));
    expect(JSON.stringify(rows[0])).not.toContain(stashed.token);
  });

  it("expires in 24 hours", async () => {
    const now = new Date("2026-11-14T10:00:00Z");
    const parsed = parseGuestDraftRequest({ propertyId: "prop-1", form });
    if (!parsed.ok) throw new Error("parse failed");
    const stashed = await stashGuestApplicationDraft(makeDb() as never, parsed.value, now);
    if (!stashed.ok) throw new Error("stash failed");
    expect(Date.parse(stashed.expiresAt) - now.getTime()).toBe(GUEST_DRAFT_TTL_MS);
    expect(GUEST_DRAFT_TTL_MS).toBe(24 * 60 * 60 * 1000);

    const claimed = await claimGuestApplicationDraft(makeDb() as never, {
      userId: "u1",
      contact: { email: "jordan@example.test", phoneE164: null },
      propertyId: "prop-1",
      now: new Date(now.getTime() + GUEST_DRAFT_TTL_MS + 1000),
    });
    expect(claimed).toEqual({ ok: false, reason: "none" });
  });

  it("refuses an unknown home and an oversized or contact-less draft", async () => {
    expect(parseGuestDraftRequest({ propertyId: "prop-1", form: { ...form, email: "nope" } }).ok).toBe(false);
    expect(parseGuestDraftRequest({ propertyId: "prop-1", form: { ...form, phone: "12" } }).ok).toBe(false);
    expect(parseGuestDraftRequest({ propertyId: "prop-1", form: { ...form, blob: "x".repeat(250 * 1024) } }).ok).toBe(false);
    const parsed = parseGuestDraftRequest({ propertyId: "ghost", form });
    if (!parsed.ok) throw new Error("parse failed");
    const stashed = await stashGuestApplicationDraft(makeDb() as never, parsed.value);
    expect(stashed).toMatchObject({ ok: false, status: 404 });
    expect(rows).toHaveLength(0);
  });
});

describe("claim needs proof, and is single use", () => {
  async function held() {
    const parsed = parseGuestDraftRequest({ propertyId: "prop-1", form });
    if (!parsed.ok) throw new Error("parse failed");
    const stashed = await stashGuestApplicationDraft(makeDb() as never, parsed.value);
    if (!stashed.ok) throw new Error("stash failed");
    return stashed.token;
  }

  it("hands the draft to the verified email, once, and wipes the stored body", async () => {
    const token = await held();
    const first = await claimGuestApplicationDraft(makeDb() as never, { userId: "u1", contact: { email: "jordan@example.test", phoneE164: null }, propertyId: "prop-1", token });
    expect(first).toMatchObject({ ok: true, propertyId: "prop-1" });
    expect(rows[0]).toMatchObject({ status: "claimed", claimed_by_user_id: "u1", draft: {} });
    const second = await claimGuestApplicationDraft(makeDb() as never, { userId: "u1", contact: { email: "jordan@example.test", phoneE164: null }, propertyId: "prop-1", token });
    expect(second).toEqual({ ok: false, reason: "none" });
  });

  it("hands the draft to the verified phone", async () => {
    await held();
    const claimed = await claimGuestApplicationDraft(makeDb() as never, { userId: "u1", contact: { email: null, phoneE164: "+12065550142" }, propertyId: "prop-1" });
    expect(claimed.ok).toBe(true);
  });

  it("never hands it over on the token or the property id alone", async () => {
    const token = await held();
    expect(await claimGuestApplicationDraft(makeDb() as never, { userId: "u1", contact: { email: null, phoneE164: null }, propertyId: "prop-1", token })).toEqual({ ok: false, reason: "none" });
    expect(await claimGuestApplicationDraft(makeDb() as never, { userId: "u2", contact: { email: "someone-else@example.test", phoneE164: "+12065550199" }, propertyId: "prop-1", token })).toEqual({ ok: false, reason: "none" });
    expect(rows[0]!.status).toBe("pending");
  });

  it("does not look up a malformed token", async () => {
    await held();
    expect(await claimGuestApplicationDraft(makeDb() as never, { userId: "u1", contact: { email: "jordan@example.test", phoneE164: null }, propertyId: "prop-1", token: "x" })).toEqual({ ok: false, reason: "none" });
  });
});

describe("routes", () => {
  it("stash: validates, rate-limits, and creates NO account", async () => {
    const ok = await stashRoute(jsonReq("/api/public/application-drafts", { propertyId: "prop-1", form }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; token: string };
    expect(isWellFormedGuestDraftToken(body.token)).toBe(true);
    expect(authAdminTouched).toBe(false);

    const bad = await stashRoute(jsonReq("/api/public/application-drafts", { propertyId: "prop-1", form: { ...form, email: "x" } }));
    expect(bad.status).toBe(400);

    rateLimit.mockResolvedValue({ ok: false });
    const limited = await stashRoute(jsonReq("/api/public/application-drafts", { propertyId: "prop-1", form }));
    expect(limited.status).toBe(429);
    expect(rows).toHaveLength(1);
  });

  it("stash: a listing that is not live is a 404", async () => {
    const res = await stashRoute(jsonReq("/api/public/application-drafts", { propertyId: "ghost", form }));
    expect(res.status).toBe(404);
  });

  it("claim: signed out is 401", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const res = await claimRoute(jsonReq("/api/resident/application-drafts/claim", { propertyId: "prop-1" }));
    expect(res.status).toBe(401);
  });

  it("claim: an UNCONFIRMED email proves nothing, a verified phone does", async () => {
    await stashRoute(jsonReq("/api/public/application-drafts", { propertyId: "prop-1", form }));
    getUser.mockResolvedValue({ data: { user: { id: "u1", email: "jordan@example.test", email_confirmed_at: null } } });
    readPhoneIdentity.mockResolvedValue({ phone: "+12065550142", verified: false });
    const unproven = await claimRoute(jsonReq("/api/resident/application-drafts/claim", { propertyId: "prop-1" }));
    expect(await unproven.json()).toEqual({ ok: false });

    readPhoneIdentity.mockResolvedValue({ phone: "+12065550142", verified: true });
    const proven = await claimRoute(jsonReq("/api/resident/application-drafts/claim", { propertyId: "prop-1" }));
    const body = (await proven.json()) as { ok: boolean; form: Row };
    expect(body.ok).toBe(true);
    expect(body.form.fullLegalName).toBe("Jordan Guest");
  });
});
