import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
let sessionUser: { id: string; email?: string } | null = null;
let profile: { email: string; phone: string; role: string; full_name?: string } | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: sessionUser } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile }) }) }) }),
  }),
}));
const roles = new Set<string>();
const authorizeResidentRole = vi.fn(async (_db: unknown, params: { userId: string | null | undefined; legacyRole: string | null | undefined }) =>
  params.legacyRole === "resident" || (Boolean(params.userId) && roles.has(String(params.userId))),
);
vi.mock("@/lib/auth/resident-role-access", () => ({ authorizeResidentRole: (...args: [unknown, never]) => authorizeResidentRole(...args) }));
const rateLimit = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: (...args: unknown[]) => rateLimit(...args) }));
const bookGuestStays = vi.fn();
const listGuestStays = vi.fn(async () => [{ id: "s1" }]);
const loadGuestBookableListing = vi.fn();
vi.mock("@/lib/short-stay/guest-stays.server", () => ({
  bookGuestStays: (...args: unknown[]) => bookGuestStays(...args),
  listGuestStays: (...args: unknown[]) => listGuestStays(...(args as [])),
  loadGuestBookableListing: (...args: unknown[]) => loadGuestBookableListing(...args),
}));

import { GET, POST } from "@/app/api/resident/stays/route";

const post = (body: unknown) => POST(new Request("http://localhost/api/resident/stays", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  roles.clear();
  sessionUser = { id: "u1", email: "priya@example.com" };
  profile = { email: "priya@example.com", phone: "+12065550142", role: "resident" };
  rateLimit.mockResolvedValue({ ok: true });
});

describe("GET /api/resident/stays", () => {
  it("refuses a visitor with no session", async () => {
    sessionUser = null;
    expect((await GET(new Request("http://localhost/api/resident/stays"))).status).toBe(401);
    expect(listGuestStays).not.toHaveBeenCalled();
  });

  it("refuses an account that does not hold the resident role (a manager-only login)", async () => {
    profile = { email: "m@example.com", phone: "", role: "manager" };
    expect((await GET(new Request("http://localhost/api/resident/stays"))).status).toBe(401);
    expect(authorizeResidentRole).toHaveBeenCalledWith(expect.anything(), { userId: "u1", legacyRole: "manager" });
  });

  it("admits a manager who also holds the resident role (profile_roles, not the legacy column)", async () => {
    profile = { email: "m@example.com", phone: "", role: "manager" };
    roles.add("u1");
    const res = await GET(new Request("http://localhost/api/resident/stays"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stays: [{ id: "s1" }] });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("lists only the signed-in login's stays: the id comes from the session", async () => {
    await GET(new Request("http://localhost/api/resident/stays?userId=someone-else"));
    expect(listGuestStays).toHaveBeenCalledWith(expect.anything(), { userId: "u1" });
  });

  it("reads one house for the sheet, and 404s a home that takes no short stays", async () => {
    loadGuestBookableListing.mockResolvedValueOnce({ propertyId: "p1", rooms: [] });
    const ok = await GET(new Request("http://localhost/api/resident/stays?propertyId=p1"));
    expect(ok.status).toBe(200);
    expect(loadGuestBookableListing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ propertyId: "p1", userId: "u1", phone: "+12065550142" }));
    loadGuestBookableListing.mockResolvedValueOnce(null);
    expect((await GET(new Request("http://localhost/api/resident/stays?propertyId=p2"))).status).toBe(404);
  });
});

describe("POST /api/resident/stays", () => {
  const application = { purpose: "travel", message: "Landing late.", guestNames: [] as string[], rulesAgreed: true };
  const body = { propertyId: "p1", roomId: "r1", guests: 1, ranges: [{ checkIn: "2026-10-15", checkOut: "2026-10-16" }], application };

  it("a real request is an application: it needs a purpose and the house-rules agreement, and a dry run needs neither", async () => {
    const { application: _omitted, ...bare } = body;
    void _omitted;
    expect((await post(bare)).status).toBe(400);
    expect((await post({ ...body, application: { ...application, rulesAgreed: false } })).status).toBe(400);
    expect((await post({ ...body, application: { ...application, purpose: "" } })).status).toBe(400);
    // Two guests need the second guest's name.
    expect((await post({ ...body, guests: 2 })).status).toBe(400);
    expect(bookGuestStays).not.toHaveBeenCalled();
    bookGuestStays.mockResolvedValue({ ok: true, dryRun: true, results: [], action: "none", summary: "" });
    expect((await post({ ...bare, dryRun: true })).status).toBe(200);
  });

  it("refuses a head-count outside 1..max before any guest list is built", async () => {
    for (const guests of [0, -1, 2.5, 999, "many"]) {
      expect((await post({ ...body, guests, application: { ...application, guestNames: [] } })).status).toBe(400);
    }
    expect(bookGuestStays).not.toHaveBeenCalled();
  });

  it("hands the validated application (with the agreement time stamped by the server) to the writer", async () => {
    bookGuestStays.mockResolvedValue({ ok: true, dryRun: false, results: [{ outcome: "pending" }], action: "request", summary: "1 pending" });
    const res = await post({ ...body, guests: 2, application: { ...application, guestNames: ["Sam Lee"], rulesAgreedAt: "1999-01-01" } });
    expect(res.status).toBe(200);
    const passed = bookGuestStays.mock.calls[0]![1] as { application: { purpose: string; guestNames: string[]; rulesAgreedAt: string } };
    expect(passed.application).toMatchObject({ purpose: "travel", guestNames: ["Sam Lee"] });
    expect(passed.application.rulesAgreedAt).not.toBe("1999-01-01");
  });

  it("refuses a visitor and a non-resident without touching the writer", async () => {
    sessionUser = null;
    expect((await post(body)).status).toBe(401);
    sessionUser = { id: "u2" };
    profile = { email: "v@example.com", phone: "", role: "vendor" };
    expect((await post(body)).status).toBe(401);
    expect(bookGuestStays).not.toHaveBeenCalled();
  });

  it("books as the session user and ignores any user id in the body", async () => {
    bookGuestStays.mockResolvedValue({ ok: true, dryRun: false, results: [{ outcome: "confirmed", checkIn: "2026-10-15", checkOut: "2026-10-16", nights: 1, total: 140 }], action: "confirm", summary: "1 confirmed" });
    const res = await post({ ...body, userId: "victim", residentUserId: "victim" });
    expect(res.status).toBe(200);
    expect(bookGuestStays).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "u1" }));
    expect((await res.json()).action).toBe("confirm");
  });

  it("passes a dry run through and rate-limits it separately from a booking", async () => {
    bookGuestStays.mockResolvedValue({ ok: true, dryRun: true, results: [], action: "none", summary: "" });
    await post({ ...body, dryRun: true });
    await post(body);
    expect(rateLimit.mock.calls.map((c) => String(c[0]))).toEqual(["resident-stays:check:u1", "resident-stays:book:u1"]);
  });

  it("answers 429 when the limit is hit and writes nothing", async () => {
    rateLimit.mockResolvedValue({ ok: false });
    expect((await post(body)).status).toBe(429);
    expect(bookGuestStays).not.toHaveBeenCalled();
  });

  it("keeps the per-range detail when every range is refused: a race is a 409, a bad date a 400", async () => {
    const raced = [{ outcome: "unavailable", checkIn: "2026-10-15", checkOut: "2026-10-16", nights: 1, total: null, error: "That room was just booked for those dates." }];
    bookGuestStays.mockResolvedValueOnce({ ok: true, dryRun: false, results: raced, action: "none", summary: "" });
    const res = await post(body);
    expect(res.status).toBe(409);
    expect((await res.json()).results).toEqual(raced);
    bookGuestStays.mockResolvedValueOnce({ ok: true, dryRun: false, results: [{ ...raced[0], outcome: "invalid", error: "Check-in can't be in the past." }], action: "none", summary: "" });
    expect((await post(body)).status).toBe(400);
  });

  it("a partly refused request is a 200 with each range's own outcome", async () => {
    bookGuestStays.mockResolvedValue({
      ok: true, dryRun: false, action: "confirm", summary: "1 confirmed",
      results: [{ outcome: "confirmed" }, { outcome: "unavailable", error: "taken" }],
    });
    expect((await post(body)).status).toBe(200);
  });

  it("maps the writer's refusals (limits, bad room) to their status and rejects a malformed body", async () => {
    bookGuestStays.mockResolvedValue({ ok: false, status: 429, error: "You have too many open requests." });
    expect((await post(body)).status).toBe(429);
    expect((await POST(new Request("http://localhost/api/resident/stays", { method: "POST", body: "not json" }))).status).toBe(400);
  });
});
