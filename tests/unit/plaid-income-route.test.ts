import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  actor: vi.fn(),
  offered: vi.fn(),
  compute: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/lib/plaid/income.server", () => ({
  authorizeIncomeActor: h.actor,
  incomeCheckOffered: h.offered,
  computeIncomeFromPublicToken: h.compute,
  saveIncomeVerification: h.save,
  createIncomeLinkToken: vi.fn(async () => "link-sandbox-1"),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })), clientIpFrom: () => "1.1.1.1" }));

import { POST as verify } from "@/app/api/plaid/income/verify/route";
import { POST as linkToken } from "@/app/api/plaid/income/link-token/route";

const post = (body: unknown) => new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  h.actor.mockReset().mockResolvedValue({ ok: true, userId: "user-1", db: {} });
  h.offered.mockReset().mockResolvedValue(true);
  h.save.mockReset().mockResolvedValue(undefined);
  h.compute.mockReset().mockResolvedValue({
    ok: true,
    verification: { source: "plaid", monthlyIncomeCents: 485000, months: 3, depositCount: 6, verifiedAt: "2026-11-18T00:00:00.000Z" },
  });
});

describe("POST /api/plaid/income/verify", () => {
  it("stores the SERVER figure and ignores any income the client sends", async () => {
    const res = await verify(post({ publicToken: "public-x", propertyId: "prop-1", monthlyIncomeCents: 999999900, monthlyIncome: "99999", verification: { monthlyIncomeCents: 1 }, userId: "someone-else" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: { monthlyIncomeCents: 485000, months: 3 } });
    expect(h.compute).toHaveBeenCalledWith({ publicToken: "public-x" });
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.save.mock.calls[0][1]).toMatchObject({ userId: "user-1", propertyId: "prop-1", verification: { monthlyIncomeCents: 485000 } });
  });

  it("refuses a guest (no session) and does nothing", async () => {
    h.actor.mockResolvedValue({ ok: false, status: 401, error: "Unauthorized." });
    const res = await verify(post({ publicToken: "public-x", propertyId: "prop-1" }));
    expect(res.status).toBe(401);
    expect(h.compute).not.toHaveBeenCalled();
  });

  it("is a 404 for a listing that does not offer the check", async () => {
    h.offered.mockResolvedValue(false);
    const res = await verify(post({ publicToken: "public-x", propertyId: "prop-1" }));
    expect(res.status).toBe(404);
    expect(h.compute).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("stores nothing when no regular paychecks are found", async () => {
    h.compute.mockResolvedValue({ ok: false, status: 422, error: "We couldn't find regular paychecks in that account." });
    const res = await verify(post({ publicToken: "public-x", propertyId: "prop-1" }));
    expect(res.status).toBe(422);
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe("POST /api/plaid/income/link-token", () => {
  it("mints a token only when the listing offers the check", async () => {
    expect(await (await linkToken(post({ propertyId: "prop-1" }))).json()).toEqual({ linkToken: "link-sandbox-1" });
    h.offered.mockResolvedValue(false);
    expect((await linkToken(post({ propertyId: "prop-1" }))).status).toBe(404);
  });
});
