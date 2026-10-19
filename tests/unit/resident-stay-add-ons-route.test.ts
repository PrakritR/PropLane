import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
let sessionUser: { id: string; email?: string } | null = null;
let profile: { role: string } | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: sessionUser } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile }) }) }) }),
  }),
}));
const authorizeResidentRole = vi.fn(async (_db: unknown, params: { legacyRole: string | null | undefined }) => params.legacyRole === "resident");
vi.mock("@/lib/auth/resident-role-access", () => ({ authorizeResidentRole: (...args: [unknown, never]) => authorizeResidentRole(...args) }));
const rateLimit = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: (...args: unknown[]) => rateLimit(...args) }));
const loadGuestStayForAddOns = vi.fn();
const requestStayAddOn = vi.fn();
const quoteStayAddOns = vi.fn(() => [{ kind: "early_check_in", label: "Early check-in", offer: { kind: "early_check_in", available: true, time: "12:00", priceCents: 2500 }, record: null }]);
const { StayAddOnReadError } = vi.hoisted(() => ({ StayAddOnReadError: class extends Error {} }));
vi.mock("@/lib/short-stay/stay-add-ons.server", () => ({
  StayAddOnReadError,
  loadGuestStayForAddOns: (...args: unknown[]) => loadGuestStayForAddOns(...args),
  requestStayAddOn: (...args: unknown[]) => requestStayAddOn(...args),
  quoteStayAddOns: (...args: unknown[]) => (quoteStayAddOns as (...a: unknown[]) => unknown)(...args),
}));

import { GET, POST } from "@/app/api/resident/stays/[blockId]/add-ons/route";

const context = (blockId = "block-1") => ({ params: Promise.resolve({ blockId }) });
const url = "http://localhost/api/resident/stays/block-1/add-ons";
const post = (body: unknown, blockId?: string) => POST(new Request(url, { method: "POST", body: JSON.stringify(body) }), context(blockId));

const stay = {
  blockId: "block-1",
  bookingStatus: "confirmed",
  stay: { checkIn: "2026-10-20", checkOut: "2026-10-23", checkInTime: "15:00", checkOutTime: "11:00" },
  row: { stayDetails: { estimatedArrival: "13:00", source: "guest_portal" }, residentPhone: "+12065550142", residentEmail: "x@y.test" },
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionUser = { id: "u1" };
  profile = { role: "resident" };
  rateLimit.mockResolvedValue({ ok: true });
});

describe("GET /api/resident/stays/[blockId]/add-ons", () => {
  it("refuses a visitor and a non-resident before touching the stay", async () => {
    sessionUser = null;
    expect((await GET(new Request(url), context())).status).toBe(401);
    sessionUser = { id: "u2" };
    profile = { role: "vendor" };
    expect((await GET(new Request(url), context())).status).toBe(401);
    expect(loadGuestStayForAddOns).not.toHaveBeenCalled();
  });

  it("reads the stay as the SESSION's login, answers its times and the offers, and no one else's data", async () => {
    loadGuestStayForAddOns.mockResolvedValueOnce(stay);
    const res = await GET(new Request(`${url}?userId=victim`), context());
    expect(res.status).toBe(200);
    expect(loadGuestStayForAddOns).toHaveBeenCalledWith(expect.anything(), { blockId: "block-1", userId: "u1" });
    const body = await res.json();
    expect(body.stay).toEqual({ id: "block-1", checkIn: "2026-10-20", checkOut: "2026-10-23", checkInTime: "15:00", checkOutTime: "11:00", estimatedArrival: "13:00", status: "confirmed" });
    expect(body.rows[0].offer).toEqual({ kind: "early_check_in", available: true, time: "12:00", priceCents: 2500 });
    expect(JSON.stringify(body)).not.toContain("+1206");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("a stay that is not this login's is a 404, and an unreadable calendar is a 503", async () => {
    loadGuestStayForAddOns.mockResolvedValueOnce(null);
    expect((await GET(new Request(url), context())).status).toBe(404);
    loadGuestStayForAddOns.mockRejectedValueOnce(new StayAddOnReadError());
    expect((await GET(new Request(url), context())).status).toBe(503);
  });
});

describe("POST /api/resident/stays/[blockId]/add-ons", () => {
  it("refuses a visitor without asking for anything", async () => {
    sessionUser = null;
    expect((await post({ kind: "early_check_in" })).status).toBe(401);
    expect(requestStayAddOn).not.toHaveBeenCalled();
  });

  it("passes only the kind and the time; who asks is the session, the price is never read from the body", async () => {
    requestStayAddOn.mockResolvedValueOnce({ ok: true, status: "pending", kind: "early_check_in", time: "12:00", priceCents: 2500, chargeId: "hc_1", checkoutUrl: "https://checkout.stripe.test/c/1", paymentsPath: null });
    const res = await post({ kind: "early_check_in", time: "12:00", userId: "victim", residentUserId: "victim", priceCents: 1, amountLabel: "$0.01" });
    expect(res.status).toBe(200);
    expect(requestStayAddOn).toHaveBeenCalledTimes(1);
    const input = requestStayAddOn.mock.calls[0]![1] as Record<string, unknown>;
    expect(input).toMatchObject({ blockId: "block-1", userId: "u1", kind: "early_check_in", time: "12:00" });
    expect(Object.keys(input).sort()).toEqual(["appOrigin", "blockId", "kind", "time", "userId"]);
    expect(await res.json()).toMatchObject({ status: "pending", checkoutUrl: "https://checkout.stripe.test/c/1", chargeId: "hc_1" });
  });

  it("answers the refusal's own status (a taken slot is a 409) and writes nothing else", async () => {
    requestStayAddOn.mockResolvedValueOnce({ ok: false, status: 409, error: "Early check-in isn't available that day." });
    const res = await post({ kind: "early_check_in" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Early check-in isn't available that day.");
  });

  it("rate-limits per login and answers 429 without asking", async () => {
    rateLimit.mockResolvedValueOnce({ ok: false });
    expect((await post({ kind: "early_check_in" })).status).toBe(429);
    expect(String(rateLimit.mock.calls[0]![0])).toBe("resident-stay-add-on:u1");
    expect(requestStayAddOn).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const res = await POST(new Request(url, { method: "POST", body: "not json" }), context());
    expect(res.status).toBe(400);
  });
});
