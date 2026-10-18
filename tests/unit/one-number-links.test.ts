import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const classification = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: classification.resolve,
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));

import { PHONE_BOUND_LINK_POLICY, type PhoneBoundLinkPurpose } from "@/lib/one-number/contracts";
import {
  createLinkSession,
  hashPhoneBoundToken,
  linkSessionCookieName,
  linkSessionTtlMs,
  markPhoneBoundLinkUsed,
  mintPhoneBoundLink,
  PhoneBoundLinkError,
  resolvePhoneBoundLink,
  revokePhoneBoundLinksForTarget,
  verifyLinkSession,
} from "@/lib/one-number/links.server";
import { linksFakeDb } from "../helpers/links-fake-db";

const WS = "11111111-1111-1111-1111-111111111111";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
let phoneCounter = 0;
/** A fresh phone per test so the (in-memory) mint rate limit never leaks between tests. */
const nextPhone = () => `206555${String(1000 + ++phoneCounter)}`;

function seededDb() {
  return linksFakeDb({ portal_workspaces: [{ id: WS, owner_user_id: "owner-1", is_default: true }] });
}

beforeEach(() => {
  classification.resolve.mockReset();
  classification.resolve.mockResolvedValue({ kind: "normal" });
});

describe("mintPhoneBoundLink", () => {
  it("stores only the SHA-256 of the token and puts the token in a /l/ URL with no PII", async () => {
    const { db, rows } = seededDb();
    const phone = nextPhone();
    const minted = await mintPhoneBoundLink(db, {
      phoneKey: phone,
      workspaceId: WS,
      purpose: "application",
      targetType: "listing",
      targetId: "prop-1",
      origin: "https://proplane.test",
    });

    expect(minted.token).toHaveLength(43); // 32 random bytes, base64url
    expect(minted.url).toBe(`https://proplane.test/l/${minted.token}`);
    expect(minted.url).not.toContain(phone);

    const [row] = rows.phone_bound_links!;
    expect(row!.token_hash).toBe(createHash("sha256").update(minted.token).digest("hex"));
    // The raw token is nowhere in what was stored.
    expect(JSON.stringify(rows)).not.toContain(minted.token);
    expect(row).not.toHaveProperty("token");
  });

  it("applies the policy: expiry and code requirement per purpose", async () => {
    const now = new Date("2026-10-18T12:00:00Z");
    for (const purpose of Object.keys(PHONE_BOUND_LINK_POLICY) as PhoneBoundLinkPurpose[]) {
      const { db, rows } = seededDb();
      await mintPhoneBoundLink(db, {
        phoneKey: nextPhone(), workspaceId: WS, purpose, targetType: "t", targetId: "x", now,
      });
      const policy = PHONE_BOUND_LINK_POLICY[purpose];
      const row = rows.phone_bound_links![0]!;
      expect(row.requires_otp).toBe(policy.requiresOtp);
      if (policy.ttlHours === "until_closed") expect(row.expires_at).toBeNull();
      else expect(new Date(String(row.expires_at)).getTime()).toBe(now.getTime() + policy.ttlHours * HOUR);
    }
    expect(PHONE_BOUND_LINK_POLICY.gallery.ttlHours).toBe(30 * 24);
    expect(PHONE_BOUND_LINK_POLICY.rent.ttlHours).toBe(10 * 24);
    expect(PHONE_BOUND_LINK_POLICY.job.ttlHours).toBe("until_closed");
  });

  it("a newer link for the same phone, purpose and target replaces the older one", async () => {
    const { db } = seededDb();
    const phoneKey = nextPhone();
    const input = { phoneKey, workspaceId: WS, purpose: "rent", targetType: "charge", targetId: "c1" } as const;
    const first = await mintPhoneBoundLink(db, input);
    const second = await mintPhoneBoundLink(db, input);
    expect(await resolvePhoneBoundLink(db, first.token)).toBeNull();
    expect((await resolvePhoneBoundLink(db, second.token))?.link.targetId).toBe("c1");
  });

  it("refuses a workspace owned by a classified test account, and malformed input", async () => {
    const { db, rows } = seededDb();
    classification.resolve.mockResolvedValue({ kind: "classified", workspaceId: "w", role: "manager", state: "active" });
    await expect(
      mintPhoneBoundLink(db, { phoneKey: nextPhone(), workspaceId: WS, purpose: "gallery", targetType: "listing", targetId: "p" }),
    ).rejects.toBeInstanceOf(PhoneBoundLinkError);
    expect(rows.phone_bound_links ?? []).toHaveLength(0);

    classification.resolve.mockResolvedValue({ kind: "normal" });
    await expect(
      mintPhoneBoundLink(db, { phoneKey: "123", workspaceId: WS, purpose: "gallery", targetType: "listing", targetId: "p" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      mintPhoneBoundLink(db, { phoneKey: nextPhone(), workspaceId: WS, purpose: "nope" as never, targetType: "x", targetId: "p" }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("caps links per phone per hour", async () => {
    const { db } = seededDb();
    const phoneKey = nextPhone();
    for (let i = 0; i < 20; i += 1) {
      await mintPhoneBoundLink(db, { phoneKey, workspaceId: WS, purpose: "gallery", targetType: "listing", targetId: `p${i}` });
    }
    await expect(
      mintPhoneBoundLink(db, { phoneKey, workspaceId: WS, purpose: "gallery", targetType: "listing", targetId: "p-over" }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("resolvePhoneBoundLink: one uniform null", () => {
  async function mint(purpose: PhoneBoundLinkPurpose = "application", now = new Date("2026-10-18T12:00:00Z")) {
    const fake = seededDb();
    const minted = await mintPhoneBoundLink(fake.db, {
      phoneKey: nextPhone(), workspaceId: WS, purpose, targetType: "listing", targetId: "p", now,
    });
    return { ...fake, minted, now };
  }

  it("resolves a live link and counts the open", async () => {
    const { db, rows, minted, now } = await mint();
    const resolved = await resolvePhoneBoundLink(db, minted.token, { now });
    expect(resolved?.link).toMatchObject({ purpose: "application", targetId: "p", requiresOtp: true, workspaceId: WS });
    expect(rows.phone_bound_links![0]!.open_count).toBe(1);
    await resolvePhoneBoundLink(db, minted.token, { now, count: false });
    expect(rows.phone_bound_links![0]!.open_count).toBe(1);
  });

  it("expired, revoked, used, unknown and malformed tokens all read as null", async () => {
    const { db, minted, now } = await mint("tour");
    const later = new Date(now.getTime() + 7 * DAY + 1000);
    expect(await resolvePhoneBoundLink(db, minted.token, { now: later })).toBeNull();

    const revoked = await mint("tour");
    await revokePhoneBoundLinksForTarget(revoked.db, { targetType: "listing", targetId: "p" });
    expect(await resolvePhoneBoundLink(revoked.db, revoked.minted.token, { now: revoked.now })).toBeNull();

    const used = await mint("rent");
    const linkId = used.rows.phone_bound_links![0]!.id as string;
    await markPhoneBoundLinkUsed(used.db, linkId);
    expect(await resolvePhoneBoundLink(used.db, used.minted.token, { now: used.now })).toBeNull();

    const live = await mint();
    expect(await resolvePhoneBoundLink(live.db, "A".repeat(43), { now: live.now })).toBeNull();
    expect(await resolvePhoneBoundLink(live.db, "short", { now: live.now })).toBeNull();
    expect(await resolvePhoneBoundLink(live.db, "../../etc/passwd", { now: live.now })).toBeNull();
    expect(await resolvePhoneBoundLink(live.db, "", { now: live.now })).toBeNull();
  });

  it("a job link never expires on its own but stops when its job closes", async () => {
    const { db, minted } = await mint("job");
    const farFuture = new Date("2030-01-01T00:00:00Z");
    expect(await resolvePhoneBoundLink(db, minted.token, { now: farFuture })).not.toBeNull();
    expect(await revokePhoneBoundLinksForTarget(db, { targetType: "listing", targetId: "p", purpose: "job" })).toBe(1);
    expect(await resolvePhoneBoundLink(db, minted.token, { now: farFuture })).toBeNull();
  });

  it("treats a database without the table as nothing there", async () => {
    const { db } = linksFakeDb({}, { broken: ["phone_bound_links"] });
    expect(await resolvePhoneBoundLink(db, "A".repeat(43))).toBeNull();
    expect(await revokePhoneBoundLinksForTarget(db, { targetType: "x", targetId: "y" })).toBe(0);
  });
});

describe("verified link sessions", () => {
  const link = (over: Partial<Parameters<typeof createLinkSession>[1]> = {}) => ({
    id: "link-1", phoneKey: "2065550100", purpose: "application" as PhoneBoundLinkPurpose, expiresAt: null as string | null, ...over,
  });

  it("is 30 minutes for rent and payouts, 7 days for everything else", async () => {
    expect(linkSessionTtlMs("rent")).toBe(30 * 60 * 1000);
    expect(linkSessionTtlMs("payouts")).toBe(30 * 60 * 1000);
    for (const purpose of ["application", "lease", "move_in", "gallery", "tour", "job"] as const) {
      expect(linkSessionTtlMs(purpose)).toBe(7 * DAY);
    }
    const now = new Date("2026-10-18T12:00:00Z");
    const { db, rows } = linksFakeDb();
    const money = await createLinkSession(db, link({ purpose: "rent" }), now);
    expect(money!.maxAgeSeconds).toBe(30 * 60);
    expect(new Date(String(rows.phone_bound_link_sessions![0]!.expires_at)).getTime()).toBe(now.getTime() + 30 * 60 * 1000);
    const other = await createLinkSession(db, link({ id: "link-2" }), now);
    expect(other!.maxAgeSeconds).toBe(7 * 24 * 60 * 60);
  });

  it("never outlives the link, and stores only a hash", async () => {
    const now = new Date("2026-10-18T12:00:00Z");
    const { db, rows } = linksFakeDb();
    const session = await createLinkSession(db, link({ expiresAt: new Date(now.getTime() + 2 * HOUR).toISOString() }), now);
    expect(session!.maxAgeSeconds).toBe(2 * 60 * 60);
    expect(JSON.stringify(rows)).not.toContain(session!.token);
    expect(await createLinkSession(db, link({ expiresAt: new Date(now.getTime() - 1).toISOString() }), now)).toBeNull();
  });

  it("verifies only on the same link and phone, and only while live", async () => {
    const now = new Date("2026-10-18T12:00:00Z");
    const { db } = linksFakeDb();
    const session = (await createLinkSession(db, link({ purpose: "rent" }), now))!;
    expect(await verifyLinkSession(db, link(), session.token, now)).toBe(true);
    expect(await verifyLinkSession(db, link({ id: "other-link" }), session.token, now)).toBe(false);
    expect(await verifyLinkSession(db, link({ phoneKey: "2065550199" }), session.token, now)).toBe(false);
    expect(await verifyLinkSession(db, link(), `${session.token}x`, now)).toBe(false);
    expect(await verifyLinkSession(db, link(), undefined, now)).toBe(false);
    expect(await verifyLinkSession(db, link(), session.token, new Date(now.getTime() + 31 * 60 * 1000))).toBe(false);
  });

  it("names its cookie from the token hash, one per link", () => {
    const a = linkSessionCookieName("A".repeat(43));
    const b = linkSessionCookieName("B".repeat(43));
    expect(a).toBe(`pbl_${hashPhoneBoundToken("A".repeat(43)).slice(0, 16)}`);
    expect(a).not.toBe(b);
  });
});
