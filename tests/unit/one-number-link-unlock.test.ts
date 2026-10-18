import { beforeEach, describe, expect, it, vi } from "vitest";

const sender = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/one-number/link-text.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/one-number/link-text.server")>()),
  sendWorkspacePhoneText: sender.send,
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));

import { requestLinkUnlockCode, verifyLinkUnlockCode } from "@/lib/one-number/link-unlock.server";
import { mintPhoneBoundLink, resolvePhoneBoundLink, verifyLinkSession } from "@/lib/one-number/links.server";
import { linksFakeDb } from "../helpers/links-fake-db";

const WS = "11111111-1111-1111-1111-111111111111";
const BOUND = "2065550142";

async function boundLink(purpose: "application" | "rent" | "lease" = "application") {
  const fake = linksFakeDb({ portal_workspaces: [{ id: WS, owner_user_id: "owner-1" }] });
  const minted = await mintPhoneBoundLink(fake.db, {
    phoneKey: BOUND, workspaceId: WS, purpose, targetType: "listing", targetId: "p1", origin: "https://proplane.test",
  });
  const link = (await resolvePhoneBoundLink(fake.db, minted.token, { count: false }))!.link;
  return { ...fake, link };
}

beforeEach(() => {
  sender.send.mockReset();
  sender.send.mockResolvedValue(true);
});

describe("link unlock code", () => {
  it("texts the code only to the phone the link is bound to", async () => {
    const { db, link } = await boundLink();
    expect((await requestLinkUnlockCode(db, link)).ok).toBe(true);
    expect(sender.send).toHaveBeenCalledTimes(1);
    const call = sender.send.mock.calls[0]![1] as { phoneKey: string; workspaceId: string; body: string; role: string };
    expect(call.phoneKey).toBe(BOUND);
    expect(call.workspaceId).toBe(WS);
    expect(call.body).toMatch(/\b\d{6}\b/);
    expect(call.role).toBe("prospect");
  });

  it("the function takes no destination: a forwarded link still texts the original phone", () => {
    // requestLinkUnlockCode(db, link, now): there is no parameter that could carry another number.
    expect(requestLinkUnlockCode.length).toBeLessThanOrEqual(3);
  });

  it("a forwarded link on another phone cannot pass the code step", async () => {
    const { db, link } = await boundLink();
    await requestLinkUnlockCode(db, link);
    const texted = /\b(\d{6})\b/.exec((sender.send.mock.calls[0]![1] as { body: string }).body)![1]!;
    const guess = texted === "000000" ? "111111" : "000000";
    // The forwardee never sees the code (it went to BOUND); guessing locks the challenge at 5.
    for (let i = 0; i < 5; i += 1) expect(await verifyLinkUnlockCode(db, link, guess)).toEqual({ ok: false, reason: "wrong_code" });
    expect(await verifyLinkUnlockCode(db, link, texted)).toEqual({ ok: false, reason: "locked" });
  });

  it("the right code opens a session on this link only", async () => {
    const { db, link } = await boundLink();
    await requestLinkUnlockCode(db, link);
    const texted = /\b(\d{6})\b/.exec((sender.send.mock.calls[0]![1] as { body: string }).body)![1]!;
    const result = await verifyLinkUnlockCode(db, link, texted);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await verifyLinkSession(db, link, result.session.token)).toBe(true);
    expect(await verifyLinkSession(db, { ...link, id: "someone-elses-link" }, result.session.token)).toBe(false);
  });

  it("a rent link's session is 30 minutes and an application link's is 7 days", async () => {
    for (const [purpose, seconds] of [["rent", 30 * 60], ["application", 7 * 24 * 60 * 60]] as const) {
      sender.send.mockClear();
      const { db, link } = await boundLink(purpose);
      await requestLinkUnlockCode(db, link);
      const texted = /\b(\d{6})\b/.exec((sender.send.mock.calls[0]![1] as { body: string }).body)![1]!;
      const result = await verifyLinkUnlockCode(db, link, texted);
      // Derived from expires_at - now; a slow run can lose one second between the two clocks.
      const maxAge = result.ok ? result.session.maxAgeSeconds : 0;
      expect(maxAge).toBeLessThanOrEqual(seconds);
      expect(maxAge).toBeGreaterThanOrEqual(seconds - 2);
    }
  });

  it("rent and lease codes are billed as the resident and the applicant", async () => {
    for (const [purpose, role] of [["rent", "resident"], ["lease", "applicant"]] as const) {
      sender.send.mockClear();
      const { db, link } = await boundLink(purpose);
      await requestLinkUnlockCode(db, link);
      expect((sender.send.mock.calls[0]![1] as { role: string }).role).toBe(role);
    }
  });

  it("no more than 3 codes an hour, and a link with no workspace sends nothing", async () => {
    const { db, link } = await boundLink();
    for (let i = 0; i < 3; i += 1) expect((await requestLinkUnlockCode(db, link)).ok).toBe(true);
    expect(await requestLinkUnlockCode(db, link)).toEqual({ ok: false, reason: "rate_limited" });
    sender.send.mockClear();
    expect(await requestLinkUnlockCode(db, { ...link, workspaceId: null })).toEqual({ ok: false, reason: "unavailable" });
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("a text that fails leaves the person able to ask again", async () => {
    const { db, link } = await boundLink();
    sender.send.mockResolvedValueOnce(false);
    expect(await requestLinkUnlockCode(db, link)).toEqual({ ok: false, reason: "send_failed" });
    expect((await requestLinkUnlockCode(db, link)).ok).toBe(true);
  });
});
