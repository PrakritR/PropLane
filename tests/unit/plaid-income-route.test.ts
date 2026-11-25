import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  actor: vi.fn(),
  offered: vi.fn(),
  compute: vi.fn(),
  save: vi.fn(),
  load: vi.fn(),
  limit: vi.fn(async () => ({ ok: true }) as { ok: boolean }),
}));

vi.mock("@/lib/plaid/income.server", () => ({
  authorizeIncomeActor: h.actor,
  incomeCheckOffered: h.offered,
  computeIncomeFromPublicToken: h.compute,
  saveIncomeVerification: h.save,
  loadIncomeVerification: h.load,
  createIncomeLinkToken: vi.fn(async () => "link-sandbox-1"),
}));
vi.mock("@/lib/plaid/client.server", () => ({ plaidEnabled: () => true, logPlaidFailure: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: h.limit, clientIpFrom: () => "1.1.1.1" }));

import { POST as verify } from "@/app/api/plaid/income/verify/route";
import { POST as linkToken } from "@/app/api/plaid/income/link-token/route";
import { GET as readBack } from "@/app/api/screening/income/route";
import { incomeVerifiedLine } from "@/lib/screening/income-verification";

const post = (body: unknown) => new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  h.actor.mockReset().mockResolvedValue({ ok: true, userId: "user-1", db: {} });
  h.offered.mockReset().mockResolvedValue(true);
  h.save.mockReset().mockResolvedValue(undefined);
  h.load.mockReset().mockResolvedValue(null);
  h.limit.mockReset().mockResolvedValue({ ok: true });
  h.compute.mockReset().mockResolvedValue({
    ok: true,
    verification: { source: "plaid", monthlyIncomeCents: 485000, months: 3, depositCount: 6, verifiedAt: "2026-11-18T00:00:00.000Z" },
  });
});

describe("POST /api/plaid/income/verify", () => {
  it("stores the SERVER figure and ignores any income the client sends", async () => {
    const res = await verify(post({ publicToken: "public-x", propertyId: "prop-1", monthlyIncomeCents: 999999900, monthlyIncome: "99999", verification: { monthlyIncomeCents: 1 }, userId: "someone-else" }));
    expect(res.status).toBe(200);
    // The applicant sees the same basis the manager does, in the same shape the read-back GET answers with.
    expect(await res.json()).toEqual({
      verified: { monthlyIncomeCents: 485000, months: 3, depositCount: 6, verifiedAt: "2026-11-18T00:00:00.000Z" },
    });
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

describe("GET /api/screening/income", () => {
  const stored = {
    source: "plaid" as const,
    monthlyIncomeCents: 485000,
    months: 3,
    depositCount: 6,
    verifiedAt: "2026-11-03T19:00:00.000Z",
    institutionName: "First Platypus Bank",
  };

  // The applicant reloads the Work-and-income step inside the 30-day freshness window and sees the figure again.
  // The line they see is drawn by `incomeVerifiedLine` from THIS payload, so the payload has to carry every clause
  // the line draws. Plausible wrong behaviour this rejects: a narrower projection, which rendered
  // "(undefined deposits)" and silently dropped the short-history note this basis exists to disclose.
  it("answers with the whole basis the applicant's line renders", async () => {
    h.load.mockResolvedValue(stored);
    const res = await readBack(new Request("http://localhost/api/screening/income?propertyId=prop-1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { offered: boolean; verified: Record<string, unknown> };
    expect(body.offered).toBe(true);
    expect(body.verified).toEqual({
      monthlyIncomeCents: 485000,
      months: 3,
      depositCount: 6,
        verifiedAt: "2026-11-03T19:00:00.000Z",
    });
    expect(incomeVerifiedLine({ source: "plaid", ...(body.verified as never) })).toBe(
      "✓ $4,850/mo avg of payroll deposits, last 90 days (6 deposits) · as of Nov 3, 2026",
    );
  });

  // Oracle: the ceiling docs/agents/plaid.md § Invariants puts on every income route - "being signed in is not a
  // budget". This one reads rows rather than calling Plaid, so it carries the read ceiling, but a session that loops
  // it must still be refused before the listing and verification reads run. Plausible wrong behaviour this rejects:
  // an unbounded authenticated read, which is what the route shipped with.
  it("refuses a looping session before it reads the listing or the figure", async () => {
    h.load.mockResolvedValue(stored);
    h.limit.mockResolvedValue({ ok: false });
    const res = await readBack(new Request("http://localhost/api/screening/income?propertyId=prop-1"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ offered: false, verified: null });
    expect(h.offered).not.toHaveBeenCalled();
    expect(h.load).not.toHaveBeenCalled();
  });

  it("answers nothing when there is no stored figure, and never leaks one to a guest", async () => {
    const url = "http://localhost/api/screening/income?propertyId=prop-1";
    expect(await (await readBack(new Request(url))).json()).toEqual({ offered: true, verified: null });
    h.load.mockResolvedValue(stored);
    h.actor.mockResolvedValue({ ok: false, status: 401, error: "Unauthorized." });
    expect(await (await readBack(new Request(url))).json()).toEqual({ offered: false, verified: null });
  });
});
