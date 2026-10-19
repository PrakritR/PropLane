 
// A resident texts for their rent link. The link is bound to their phone, opens only after a one-time code
// texted to THAT phone, and the code step locks after five wrong guesses. Real tool, link service, OTP and
// session code over a stateful fake; the only stand-in is the text that carries the code.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sim = vi.hoisted(() => ({ texts: [] as Array<{ phoneKey: string; workspaceId: string; body: string; role: string }>, charges: vi.fn() }));
vi.mock("@/lib/one-number/link-text.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/one-number/link-text.server")>()),
  sendWorkspacePhoneText: vi.fn(async (_db: unknown, input: { phoneKey: string; workspaceId: string; body: string; role: string }) => {
    sim.texts.push(input);
    return true;
  }),
}));
vi.mock("@/lib/tools/domains/resident/balance", () => ({ loadOwnCharges: sim.charges }));
vi.mock("@/lib/tools/domains/leasing-sms", () => ({ resolveLiveListingForSms: vi.fn() }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));

import { requestLinkUnlockCode, verifyLinkUnlockCode } from "@/lib/one-number/link-unlock.server";
import { mintPhoneBoundLink, resolvePhoneBoundLink, verifyLinkSession } from "@/lib/one-number/links.server";
import { residentSendMyLinkTool } from "@/lib/tools/domains/one-number-links";
import { linksFakeDb } from "../../helpers/links-fake-db";

const WS = "ws-a";
const PHONE_KEY = "2065550142";
const DAY = 24 * 60 * 60 * 1000;

function world() {
  return linksFakeDb({
    sms_runtime_config: [{ singleton: true, line_mode: "shared", shared_number_e164: "+12065550100", shared_pilot_workspace_ids: [] }],
    portal_workspaces: [{ id: WS, owner_user_id: "owner-a", is_default: true }],
    manager_property_records: [{ id: "prop-1", workspace_id: WS, manager_user_id: "owner-a" }],
    profiles: [{ id: "res-1", phone: "(206) 555-0142", phone_verified_at: "2026-09-01T00:00:00Z" }],
  });
}
const ctx = (db: never) =>
  ({ kind: "resident", userId: "res-1", email: "r@e.com", managerIds: ["owner-a"], activeManagerId: "owner-a", channel: "sms", phase: "approved", db }) as never;

async function rentLink(db: never) {
  sim.charges.mockResolvedValue([{ id: "c1", status: "pending", propertyId: "prop-1" }]);
  const result = await residentSendMyLinkTool.handler(ctx(db), { purpose: "rent" });
  if (!result.ok) throw new Error(`no link: ${result.error}`);
  const token = result.url.split("/l/")[1]!;
  const resolved = await resolvePhoneBoundLink(db, token, { count: false });
  return { token, link: resolved!.link, url: result.url };
}
const codeOf = (i: number) => /\b(\d{6})\b/.exec(sim.texts[i]!.body)![1]!;
const wrongOf = (code: string) => (code === "000000" ? "111111" : "000000");

beforeEach(() => {
  sim.texts.length = 0;
  sim.charges.mockReset();
});

describe("rent link by text", () => {
  it("mints a link bound to the verified phone: only a hash is stored and the url carries no phone", async () => {
    const { db, rows } = world();
    const { token, url, link } = await rentLink(db);
    expect(link).toMatchObject({ phoneKey: PHONE_KEY, purpose: "rent", workspaceId: WS, requiresOtp: true });
    expect(url).not.toContain(PHONE_KEY);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows.phone_bound_links![0]).toHaveProperty("token_hash");
  });

  it("the page asks for a code; the code goes only to the bound phone, billed as the resident, in one short text", async () => {
    const { db } = world();
    const { link } = await rentLink(db);
    expect((await requestLinkUnlockCode(db, link)).ok).toBe(true);
    expect(sim.texts).toHaveLength(1);
    expect(sim.texts[0]).toMatchObject({ phoneKey: PHONE_KEY, workspaceId: WS, role: "resident" });
    expect(sim.texts[0]!.body.length).toBeLessThanOrEqual(160);
    expect(sim.texts[0]!.body).not.toMatch(/https?:/);
    expect(/^[\x20-\x7E]*$/.test(sim.texts[0]!.body)).toBe(true);
  });

  it("the right code opens a 30-minute session for this link and no other", async () => {
    const { db } = world();
    const { link } = await rentLink(db);
    await requestLinkUnlockCode(db, link);
    const opened = await verifyLinkUnlockCode(db, link, codeOf(0));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.session.maxAgeSeconds).toBeLessThanOrEqual(30 * 60);
    expect(opened.session.maxAgeSeconds).toBeGreaterThan(29 * 60);
    expect(await verifyLinkSession(db, link, opened.session.token)).toBe(true);
    expect(await verifyLinkSession(db, { ...link, id: "another-link" }, opened.session.token)).toBe(false);
    // A code works once.
    expect(await verifyLinkUnlockCode(db, link, codeOf(0))).toEqual({ ok: false, reason: "no_challenge" });
  });
});

describe("OTP lockout", () => {
  it("five wrong guesses lock that code, even for the right one", async () => {
    const { db } = world();
    const { link } = await rentLink(db);
    await requestLinkUnlockCode(db, link);
    const right = codeOf(0);
    for (let i = 0; i < 5; i += 1) expect(await verifyLinkUnlockCode(db, link, wrongOf(right))).toEqual({ ok: false, reason: "wrong_code" });
    expect(await verifyLinkUnlockCode(db, link, right)).toEqual({ ok: false, reason: "locked" });
    expect(await verifyLinkUnlockCode(db, link, right)).toEqual({ ok: false, reason: "locked" });
  });

  it("a guesser gets at most 10 wrong tries: two codes of five, then the third code is refused (the phone-wide failure cap)", async () => {
    const { db } = world();
    const { link } = await rentLink(db);
    let tries = 0;
    for (let round = 0; round < 2; round += 1) {
      expect((await requestLinkUnlockCode(db, link)).ok).toBe(true);
      const right = codeOf(round);
      for (let i = 0; i < 5; i += 1) {
        expect((await verifyLinkUnlockCode(db, link, wrongOf(right))).ok).toBe(false);
        tries += 1;
      }
      expect(await verifyLinkUnlockCode(db, link, right)).toEqual({ ok: false, reason: "locked" });
    }
    expect(tries).toBe(10);
    expect(await requestLinkUnlockCode(db, link)).toEqual({ ok: false, reason: "rate_limited" });
    expect(sim.texts).toHaveLength(2);
  });

  it("a fresh code after a lockout works, and the locked one stays dead", async () => {
    const { db } = world();
    const { link } = await rentLink(db);
    await requestLinkUnlockCode(db, link);
    const first = codeOf(0);
    for (let i = 0; i < 5; i += 1) await verifyLinkUnlockCode(db, link, wrongOf(first));
    await requestLinkUnlockCode(db, link);
    const second = codeOf(1);
    expect(second).not.toBe(first); // a different challenge
    expect((await verifyLinkUnlockCode(db, link, second)).ok).toBe(true);
  });

  it("a forwarded link opened by someone else never sees the code and cannot pass", async () => {
    const { db } = world();
    const { link } = await rentLink(db);
    await requestLinkUnlockCode(db, link); // the forwardee taps "text me a code": it lands on the BOUND phone
    expect(sim.texts.every((t) => t.phoneKey === PHONE_KEY)).toBe(true);
    for (let i = 0; i < 5; i += 1) expect((await verifyLinkUnlockCode(db, link, wrongOf(codeOf(0)))).ok).toBe(false);
    expect(await verifyLinkUnlockCode(db, link, codeOf(0))).toEqual({ ok: false, reason: "locked" });
  });

  it("garbage in the code box is a wrong code, not an error", async () => {
    const { db } = world();
    const { link } = await rentLink(db);
    await requestLinkUnlockCode(db, link);
    for (const junk of ["", "abc", "12345", "1234567", null, undefined, {}]) {
      expect(await verifyLinkUnlockCode(db, link, junk)).toMatchObject({ ok: false });
    }
  });
});

describe("expiry and replacement", () => {
  it("a rent link is dead after 10 days", async () => {
    const { db } = world();
    const now = new Date(Date.now() - 11 * DAY);
    const minted = await mintPhoneBoundLink(db, { phoneKey: PHONE_KEY, workspaceId: WS, purpose: "rent", targetType: "charge", targetId: "c1", now });
    expect(await resolvePhoneBoundLink(db, minted.token, { count: false })).toBeNull();
    const fresh = await mintPhoneBoundLink(db, { phoneKey: PHONE_KEY, workspaceId: WS, purpose: "rent", targetType: "charge", targetId: "c1" });
    expect(await resolvePhoneBoundLink(db, fresh.token, { count: false })).not.toBeNull();
  });

  it("asking again replaces the old link: the earlier one stops working", async () => {
    const { db } = world();
    const first = await rentLink(db);
    const second = await rentLink(db);
    expect(await resolvePhoneBoundLink(db, first.token, { count: false })).toBeNull();
    expect(await resolvePhoneBoundLink(db, second.token, { count: false })).not.toBeNull();
  });

  it("per_workspace: the same phone-bound link, same code step, bound to the charge's workspace", async () => {
    const { db, rows } = world();
    rows.sms_runtime_config![0]!.line_mode = "per_workspace";
    sim.charges.mockResolvedValue([{ id: "c1", status: "pending", propertyId: "prop-1" }]);
    const result = await residentSendMyLinkTool.handler(ctx(db), { purpose: "rent" });
    expect(result).toMatchObject({ ok: true, purpose: "rent", requiresCode: true });
    expect(rows.phone_bound_links!.at(-1)).toMatchObject({ phone_key: PHONE_KEY, workspace_id: WS, purpose: "rent", requires_otp: true });
  });
});
