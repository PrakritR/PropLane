import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../helpers/fake-table-db";

vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));

import {
  SERVICE_SHARE_LINK_DAYS,
  SERVICE_SHARE_MAX_LIVE_LINKS_PER_SERVICE,
  SERVICE_SHARE_RESOLVE_PER_IP_PER_MIN,
  SERVICE_SHARE_SMS_PER_MANAGER_PER_DAY,
  allowServiceShareResolve,
  buildServiceShareUrl,
  consumeServiceShareSmsAllowance,
  createServiceShareLink,
  generateServiceShareToken,
  hashServiceShareToken,
  resolveServiceShareToken,
  revokeServiceShareLinks,
} from "@/lib/service-share-links.server";

type Db = Parameters<typeof createServiceShareLink>[0];

let db: ReturnType<typeof createFakeDb>;
const asDb = () => db as unknown as Db;
const base = { workOrderId: "wo-1", managerUserId: "mgr-1", createdBy: "mgr-1", recipientPhone: "+14252240508", sharePhotos: false };

beforeEach(() => {
  db = createFakeDb({ service_share_links: [] });
});

describe("service share link tokens", () => {
  it("stores only the SHA-256 of the token, never the token", async () => {
    const { link, token } = await createServiceShareLink(asDb(), base);
    const stored = db.tables.service_share_links![0]!;
    expect(stored.token_hash).toBe(hashServiceShareToken(token));
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(link.recipientPhone).toBe("+14252240508");
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("builds a /s/<token> url", () => {
    expect(buildServiceShareUrl("https://proplane.ai/", "abc_DEF-123")).toBe("https://proplane.ai/s/abc_DEF-123");
  });

  it("tokens are unique", () => {
    expect(new Set(Array.from({ length: 50 }, generateServiceShareToken)).size).toBe(50);
  });

  it("expires after 14 days", async () => {
    const now = new Date("2026-10-06T12:00:00Z");
    const { link } = await createServiceShareLink(asDb(), { ...base, now });
    expect(SERVICE_SHARE_LINK_DAYS).toBe(14);
    expect(new Date(link.expiresAt).getTime() - now.getTime()).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it("resolves a live token, counts the access, and refuses it after expiry", async () => {
    const now = new Date("2026-10-06T12:00:00Z");
    const { token } = await createServiceShareLink(asDb(), { ...base, now });
    const live = await resolveServiceShareToken(asDb(), token, { now: new Date("2026-10-10T00:00:00Z") });
    expect(live?.link.workOrderId).toBe("wo-1");
    expect(db.tables.service_share_links![0]!.access_count).toBe(1);
    expect(await resolveServiceShareToken(asDb(), token, { now: new Date("2026-10-21T00:00:00Z") })).toBeNull();
  });

  it("does not count a redeem read", async () => {
    const { token } = await createServiceShareLink(asDb(), base);
    await resolveServiceShareToken(asDb(), token, { count: false });
    expect(Number(db.tables.service_share_links![0]!.access_count ?? 0)).toBe(0);
  });

  it("refuses an unknown, malformed or hash-as-token value (the hash is not the token)", async () => {
    const { token } = await createServiceShareLink(asDb(), base);
    expect(await resolveServiceShareToken(asDb(), "nope")).toBeNull();
    expect(await resolveServiceShareToken(asDb(), "x".repeat(32))).toBeNull();
    expect(await resolveServiceShareToken(asDb(), hashServiceShareToken(token))).toBeNull();
  });

  it("revoke kills every live link on the service, and only the owner's", async () => {
    const a = await createServiceShareLink(asDb(), base);
    const b = await createServiceShareLink(asDb(), base);
    expect(await revokeServiceShareLinks(asDb(), { workOrderId: "wo-1", managerUserId: "someone-else" })).toBe(0);
    expect(await resolveServiceShareToken(asDb(), a.token)).not.toBeNull();
    expect(await revokeServiceShareLinks(asDb(), { workOrderId: "wo-1", managerUserId: "mgr-1" })).toBe(2);
    expect(await resolveServiceShareToken(asDb(), a.token)).toBeNull();
    expect(await resolveServiceShareToken(asDb(), b.token)).toBeNull();
  });

  it("caps live links per service", async () => {
    for (let i = 0; i < SERVICE_SHARE_MAX_LIVE_LINKS_PER_SERVICE; i += 1) await createServiceShareLink(asDb(), base);
    await expect(createServiceShareLink(asDb(), base)).rejects.toThrow(/most live links/);
  });

  it("refuses a link from a classified test workspace", async () => {
    const mod = await import("@/lib/test-workspaces/index.server");
    vi.mocked(mod.resolveTestWorkspaceClassification).mockResolvedValueOnce({ kind: "classified" } as never);
    await expect(createServiceShareLink(asDb(), base)).rejects.toThrow(/unavailable/);
  });
});

describe("service share rate limits", () => {
  it("caps texts per manager per day", async () => {
    const manager = `mgr-cap-${Math.random()}`;
    for (let i = 0; i < SERVICE_SHARE_SMS_PER_MANAGER_PER_DAY; i += 1) {
      expect(await consumeServiceShareSmsAllowance(manager)).toBe(true);
    }
    expect(await consumeServiceShareSmsAllowance(manager)).toBe(false);
    expect(await consumeServiceShareSmsAllowance(`${manager}-other`)).toBe(true);
  });

  it("throttles public resolves per IP and per token", async () => {
    const ip = `ip-${Math.random()}`;
    for (let i = 0; i < SERVICE_SHARE_RESOLVE_PER_IP_PER_MIN; i += 1) {
      expect(await allowServiceShareResolve({ ip, tokenHash: `${i}`.padStart(64, "0") })).toBe(true);
    }
    expect(await allowServiceShareResolve({ ip, tokenHash: "f".repeat(64) })).toBe(false);
    const tokenHash = `${Math.random()}`.padEnd(64, "a");
    let refused = false;
    for (let i = 0; i < 200 && !refused; i += 1) {
      refused = !(await allowServiceShareResolve({ ip: `fresh-${i}-${Math.random()}`, tokenHash }));
    }
    expect(refused).toBe(true);
  });
});
