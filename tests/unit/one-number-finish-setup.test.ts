// Finish setup: the draft is created only after sign-in and a proven phone, a forwarded link finishes
// nothing, the waitlist flag off means no gate, a cap holds new landlords back, an invite skips it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";
import { leadFakeDb } from "../helpers/lead-fake-db";

const mocks = vi.hoisted(() => ({
  identity: vi.fn(async (..._a: unknown[]) => ({ phone: "+12065550142", verified: true })),
  ensureManager: vi.fn(async (..._a: unknown[]) => ({ status: "portal_ready", managerId: "MGR-1", provisioned: true })),
  provisionVendor: vi.fn(async (..._a: unknown[]) => ({ ok: true })),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })), clientIpFrom: () => "1.1.1.1" }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveTestWorkspaceClassification: vi.fn(), lookupRecordTestWorkspaceId: vi.fn(async () => null) }));
vi.mock("@/lib/auth/phone-auth.server", () => ({ readPhoneIdentity: (...a: unknown[]) => mocks.identity(...a) }));
vi.mock("@/lib/auth/manager-portal-provision", () => ({ ensureFreeManagerPortalAccess: (...a: unknown[]) => mocks.ensureManager(...a) }));
vi.mock("@/lib/auth/provision-vendor-account", () => ({ provisionVendorAccountByEmail: (...a: unknown[]) => mocks.provisionVendor(...a) }));

import { finishSetup } from "@/lib/one-number/onboarding/finish-setup.server";
import { createDraftFromHints, draftIdFor, hasHouseHints, importedPropertyFromHints } from "@/lib/one-number/onboarding/house-draft.server";
import { mintSetupLink, resolveSetupLink, type SetupLink } from "@/lib/one-number/onboarding/setup-links.server";
import { decideWaitlist, waitlistConfig } from "@/lib/one-number/onboarding/waitlist.server";
import { handleInviteCommand, INVITE_COPY, inviteCommandApplies, parseInviteCommand } from "@/lib/one-number/onboarding/invite.server";

const PHONE = "2065550142";
const USER = { id: "11111111-1111-4111-8111-111111111111", email: "abc@phone.proplane.invalid" } as User;
const NOW = new Date("2026-10-18T20:00:00Z");
const deps = (env: NodeJS.ProcessEnv = {}) => ({ now: () => NOW, env });

async function link(f: ReturnType<typeof leadFakeDb>, over: Partial<Parameters<typeof mintSetupLink>[1]> = {}): Promise<SetupLink> {
  const minted = await mintSetupLink(f.db, { kind: "landlord", phoneKey: PHONE, context: { address: "61 Elm Street", rooms: 3, rent: 700, source: "demo" }, origin: "https://proplane.ai", now: NOW, ...over });
  if (!minted.ok) throw new Error("mint failed");
  const resolved = await resolveSetupLink(f.db, minted.token, NOW);
  if (!resolved) throw new Error("resolve failed");
  return resolved;
}

beforeEach(() => {
  mocks.identity.mockClear();
  mocks.identity.mockImplementation(async () => ({ phone: "+12065550142", verified: true }));
  mocks.ensureManager.mockClear();
  mocks.provisionVendor.mockClear();
});

describe("setup links", () => {
  it("stores only a hash, expires in 7 days, and a newer link replaces the older one", async () => {
    const f = leadFakeDb();
    const first = await mintSetupLink(f.db, { kind: "landlord", phoneKey: PHONE, origin: "https://proplane.ai", now: NOW });
    if (!first.ok) throw new Error("x");
    expect(JSON.stringify(f.rows.sms_setup_links)).not.toContain(first.token);
    expect(first.url).toBe(`https://proplane.ai/start/${first.token}`);
    expect(new Date(String(f.rows.sms_setup_links![0]!.expires_at)).getTime() - NOW.getTime()).toBe(7 * 24 * 3600 * 1000);
    const second = await mintSetupLink(f.db, { kind: "landlord", phoneKey: PHONE, origin: "https://proplane.ai", now: NOW });
    if (!second.ok) throw new Error("x");
    expect(await resolveSetupLink(f.db, first.token, NOW)).toBeNull();
    expect(await resolveSetupLink(f.db, second.token, NOW)).not.toBeNull();
    expect(await resolveSetupLink(f.db, second.token, new Date(NOW.getTime() + 8 * 24 * 3600 * 1000))).toBeNull();
    expect(await resolveSetupLink(f.db, "short", NOW)).toBeNull();
  });
});

describe("the draft", () => {
  it("builds a by-the-room house from address, rooms and rent", () => {
    const p = importedPropertyFromHints({ address: "61 Elm Street", rooms: 3, rent: 700 });
    expect(p).toMatchObject({ name: "61 Elm Street", address: "61 Elm Street", rentByRoom: true, bedrooms: 3 });
    expect(p.rooms).toHaveLength(3);
    expect(p.rooms.every((r) => r.rent === 700)).toBe(true);
    expect(importedPropertyFromHints({ rent: 1500 })).toMatchObject({ rentByRoom: false, monthlyRent: 1500, rooms: [] });
    expect(hasHouseHints({})).toBe(false);
    expect(hasHouseHints({ rooms: 2 })).toBe(true);
  });

  it("writes one draft, idempotent per user and link, and nothing without hints", async () => {
    const f = leadFakeDb();
    expect(await createDraftFromHints(f.db, { userId: USER.id, linkId: "L1", hints: {} })).toEqual({ created: false, propertyId: null });
    expect(f.rows.manager_property_records ?? []).toEqual([]);
    const a = await createDraftFromHints(f.db, { userId: USER.id, linkId: "L1", hints: { address: "61 Elm Street", rooms: 2, rent: 700 } });
    const b = await createDraftFromHints(f.db, { userId: USER.id, linkId: "L1", hints: { address: "61 Elm Street", rooms: 2, rent: 700 } });
    expect(a.propertyId).toBe(draftIdFor(USER.id, "L1"));
    expect(b.propertyId).toBe(a.propertyId);
    expect(f.rows.manager_property_records).toHaveLength(1);
    expect(f.rows.manager_property_records![0]).toMatchObject({ manager_user_id: USER.id, status: "draft" });
  });
});

describe("finishSetup (landlord)", () => {
  it("creates the manager account and the DRAFT only after the verified phone matches", async () => {
    const f = leadFakeDb();
    const l = await link(f);
    expect(f.rows.manager_property_records ?? []).toEqual([]);
    const out = await finishSetup(f.db, { link: l, user: USER }, deps());
    expect(out).toMatchObject({ ok: true, kind: "landlord", portalHref: "/portal/dashboard", already: false });
    expect(out.ok && out.draftPropertyId).toBe(draftIdFor(USER.id, l.id));
    expect(mocks.ensureManager).toHaveBeenCalledTimes(1);
    expect(f.rows.manager_property_records).toHaveLength(1);
    expect(f.rows.manager_property_records![0]).toMatchObject({ status: "draft", manager_user_id: USER.id });
    expect(f.rows.sms_setup_links![0]).toMatchObject({ user_id: USER.id });
    expect(f.rows.sms_setup_links![0]!.used_at).toBeTruthy();
  });

  it("an unverified account creates nothing", async () => {
    mocks.identity.mockImplementation(async () => ({ phone: null as never, verified: false }));
    const f = leadFakeDb();
    const out = await finishSetup(f.db, { link: await link(f), user: USER }, deps());
    expect(out).toEqual({ ok: false, reason: "phone_unverified" });
    expect(mocks.ensureManager).not.toHaveBeenCalled();
    expect(f.rows.manager_property_records ?? []).toEqual([]);
  });

  it("a forwarded link (signed in as a different phone) finishes nothing", async () => {
    mocks.identity.mockImplementation(async () => ({ phone: "+12065559999", verified: true }));
    const f = leadFakeDb();
    const out = await finishSetup(f.db, { link: await link(f), user: USER }, deps());
    expect(out).toEqual({ ok: false, reason: "phone_mismatch" });
    expect(mocks.ensureManager).not.toHaveBeenCalled();
    expect(f.rows.manager_property_records ?? []).toEqual([]);
  });

  it("an open web link takes whichever verified phone signed in", async () => {
    const f = leadFakeDb();
    const out = await finishSetup(f.db, { link: await link(f, { phoneKey: null }), user: USER }, deps());
    expect(out.ok).toBe(true);
  });

  it("a spent link is done for its owner and refused for anyone else", async () => {
    const f = leadFakeDb();
    const l = await link(f);
    await finishSetup(f.db, { link: l, user: USER }, deps());
    const spent = await resolveSetupLink(f.db, "x".repeat(43), NOW);
    expect(spent).toBeNull();
    const again = await finishSetup(f.db, { link: { ...l, usedAt: NOW.toISOString(), userId: USER.id }, user: USER }, deps());
    expect(again).toMatchObject({ ok: true, already: true });
    expect(mocks.ensureManager).toHaveBeenCalledTimes(1);
    const other = await finishSetup(f.db, { link: { ...l, usedAt: NOW.toISOString(), userId: "someone-else" }, user: USER }, deps());
    expect(other).toEqual({ ok: false, reason: "unavailable" });
  });

  it("a refused account does not spend the link or write a draft", async () => {
    mocks.ensureManager.mockImplementationOnce(async () => ({ status: "skipped", reason: "x" }) as never);
    const f = leadFakeDb();
    const out = await finishSetup(f.db, { link: await link(f), user: USER }, deps());
    expect(out).toEqual({ ok: false, reason: "unavailable" });
    expect(f.rows.manager_property_records ?? []).toEqual([]);
    expect(f.rows.sms_setup_links![0]!.used_at).toBeUndefined();
  });
});

describe("waitlist", () => {
  it("is off by default: no gate and no read", async () => {
    expect(waitlistConfig({})).toEqual({ enabled: false, cap: 10 });
    const f = leadFakeDb();
    expect(await decideWaitlist(f.db, { kind: "landlord", invitedByWorkspaceId: null }, {})).toEqual({ admit: true });
    expect(f.log).toEqual([]);
  });

  it("flag on: admits below the cap, waitlists at it, never gates vendors, an invite skips it", async () => {
    const env = { ONE_NUMBER_WAITLIST: "1", ONE_NUMBER_WAITLIST_CAP: "1" };
    const f = leadFakeDb({ sms_setup_links: [{ id: "old", kind: "landlord", used_at: "2026-10-01T00:00:00Z" }] });
    expect(await decideWaitlist(f.db, { kind: "landlord", invitedByWorkspaceId: null }, { ...env, ONE_NUMBER_WAITLIST_CAP: "2" })).toEqual({ admit: true });
    expect(await decideWaitlist(f.db, { kind: "landlord", invitedByWorkspaceId: null }, env)).toEqual({ admit: false, reason: "cap_reached" });
    expect(await decideWaitlist(f.db, { kind: "vendor", invitedByWorkspaceId: null }, env)).toEqual({ admit: true });
    expect(await decideWaitlist(f.db, { kind: "landlord", invitedByWorkspaceId: "ws-1" }, env)).toEqual({ admit: true });
  });

  it("an unreadable count fails closed", async () => {
    const f = leadFakeDb({}, { broken: ["sms_setup_links"] });
    expect(await decideWaitlist(f.db, { kind: "landlord", invitedByWorkspaceId: null }, { ONE_NUMBER_WAITLIST: "1" })).toEqual({ admit: false, reason: "unreadable" });
  });

  it("finishSetup holds a new landlord back at the cap: no account, no draft, link marked waitlisted but still unspent", async () => {
    const f = leadFakeDb({ sms_setup_links: [{ id: "old", kind: "landlord", used_at: "2026-10-01T00:00:00Z" }] });
    const l = await link(f);
    const out = await finishSetup(f.db, { link: l, user: USER }, deps({ ONE_NUMBER_WAITLIST: "1", ONE_NUMBER_WAITLIST_CAP: "1" }));
    expect(out).toEqual({ ok: false, reason: "waitlisted" });
    expect(mocks.ensureManager).not.toHaveBeenCalled();
    expect(f.rows.manager_property_records ?? []).toEqual([]);
    const row = f.rows.sms_setup_links!.find((r) => r.id === l.id)!;
    expect(row.waitlisted_at).toBeTruthy();
    expect(row.used_at).toBeUndefined();
  });

  it("an invited landlord finishes at the cap; an existing manager is not waitlisted", async () => {
    const env = { ONE_NUMBER_WAITLIST: "1", ONE_NUMBER_WAITLIST_CAP: "0" };
    const f = leadFakeDb();
    const invited = await link(f, { invitedByWorkspaceId: "ws-1" });
    expect((await finishSetup(f.db, { link: invited, user: USER }, deps(env))).ok).toBe(true);
    const g = leadFakeDb({ profile_roles: [{ user_id: USER.id, role: "manager" }] });
    expect((await finishSetup(g.db, { link: await link(g), user: USER }, deps(env))).ok).toBe(true);
  });
});

describe("invite command", () => {
  it("parses invite with or without a number, and is inert with the flag off", () => {
    expect(parseInviteCommand("invite 206 555 0100")).toEqual({ kind: "invite", phone: "+12065550100" });
    expect(parseInviteCommand("Invite: (206) 555-0100")).toEqual({ kind: "invite", phone: "+12065550100" });
    expect(parseInviteCommand("invite")).toEqual({ kind: "invite", phone: null });
    expect(parseInviteCommand("invited guests tonight")).toBeNull();
    expect(parseInviteCommand("who should I invite")).toBeNull();
    expect(inviteCommandApplies("invite 2065550100", {})).toBe(false);
    expect(inviteCommandApplies("invite 2065550100", { ONE_NUMBER_WAITLIST: "1" })).toBe(true);
  });

  it("without a number it asks for one and sends nothing", async () => {
    const f = leadFakeDb();
    const text = await handleInviteCommand(f.db, { workspaceId: "ws-1", ownerUserId: "o-1", body: "invite", messageSid: "SM1" });
    expect(text).toBe(INVITE_COPY.needPhone);
    expect(f.rows.sms_setup_links ?? []).toEqual([]);
  });
});
