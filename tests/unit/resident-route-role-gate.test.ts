/**
 * Route-level regression for the three resident API routes the unlocked Lease
 * section calls. They gated on the legacy single-value `profiles.role`, so the
 * captain's manager+resident account (`profiles.role='manager'`,
 * `profile_roles=['manager','resident']`) could open /resident/lease and then
 * got 403 from Extend lease, the move-out availability check, and the resident
 * SMS thread. All three now authorize off `profile_roles`, keeping a legacy
 * `profiles.role='resident'` as an accepted signal so a resident whose
 * `profile_roles` row was never backfilled is not newly locked out.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "user-both";
const EMAIL = "both@example.com";

const getUser = vi.fn();
let PROFILE: { email?: string; role: string | null } | null = null;
let PROFILE_ROLES: string[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));
vi.mock("@/lib/lease-amendment.server", () => ({
  amendLeaseMoveOutDate: vi.fn(async () => ({ ok: true, newLeaseEnd: "2027-01-01", direction: "extend" })),
  hasBothLeaseSignatures: () => false,
}));
vi.mock("@/lib/manager-sms-messages.server", () => ({
  fetchResidentSmsConversation: vi.fn(async () => ({ messages: [] })),
}));

/** Chainable Supabase stub — only the surface these three routes touch. */
function makeDb() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        neq: () => builder,
        order: () => Promise.resolve({ data: [], error: null }),
        maybeSingle() {
          if (table === "profiles") return Promise.resolve({ data: PROFILE, error: null });
          if (table === "profile_roles") {
            return Promise.resolve({
              data: PROFILE_ROLES.includes("resident") ? { role: "resident" } : null,
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
}

async function callExtendLease() {
  const { POST } = await import("@/app/api/resident/extend-lease/route");
  return POST(
    new Request("http://localhost/api/resident/extend-lease", {
      method: "POST",
      body: JSON.stringify({ newLeaseEnd: "2027-01-01" }),
    }) as never,
  );
}

async function callCheckMoveOut() {
  const { POST } = await import("@/app/api/resident/check-move-out-availability/route");
  return POST(
    new Request("http://localhost/api/resident/check-move-out-availability", {
      method: "POST",
      body: JSON.stringify({ newLeaseEnd: "2027-01-01" }),
    }) as never,
  );
}

async function callSmsConversations() {
  const { GET } = await import("@/app/api/resident/sms-conversations/route");
  return GET();
}

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: EMAIL } }, error: null });
});

describe("resident route role gate — manager+resident account", () => {
  beforeEach(() => {
    PROFILE = { email: EMAIL, role: "manager" };
    PROFILE_ROLES = ["manager", "resident"];
  });

  it("lets the extend-lease route past the role gate", async () => {
    const res = await callExtendLease();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No fully-signed lease found." });
  });

  it("lets the move-out availability route past the role gate", async () => {
    const res = await callCheckMoveOut();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true, direction: "extend" });
  });

  it("lets the resident SMS route past the role gate", async () => {
    const res = await callSmsConversations();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });
});

describe("resident route role gate — account holding no resident role", () => {
  beforeEach(() => {
    PROFILE = { email: EMAIL, role: "manager" };
    PROFILE_ROLES = ["manager"];
  });

  it("refuses the extend-lease route", async () => {
    const res = await callExtendLease();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Residents only." });
  });

  it("refuses the move-out availability route", async () => {
    const res = await callCheckMoveOut();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Residents only." });
  });

  it("refuses the resident SMS route", async () => {
    const res = await callSmsConversations();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Resident access required." });
  });
});

describe("resident route role gate — legacy resident with no profile_roles row", () => {
  beforeEach(() => {
    PROFILE = { email: EMAIL, role: "resident" };
    PROFILE_ROLES = [];
  });

  it("still allows the extend-lease route", async () => {
    const res = await callExtendLease();
    expect(res.status).toBe(404);
  });

  it("still allows the move-out availability route", async () => {
    const res = await callCheckMoveOut();
    expect(res.status).toBe(200);
  });

  it("still allows the resident SMS route", async () => {
    const res = await callSmsConversations();
    expect(res.status).toBe(200);
  });
});

describe("resident route role gate — unauthenticated", () => {
  beforeEach(() => {
    PROFILE = null;
    PROFILE_ROLES = [];
    getUser.mockResolvedValue({ data: { user: null }, error: null });
  });

  it("still answers 401 on every route", async () => {
    expect((await callExtendLease()).status).toBe(401);
    expect((await callCheckMoveOut()).status).toBe(401);
    expect((await callSmsConversations()).status).toBe(401);
  });
});

describe("resident route role gate — resident with no email on file", () => {
  beforeEach(() => {
    PROFILE = { email: "", role: "resident" };
    PROFILE_ROLES = ["resident"];
    getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: null } }, error: null });
  });

  it("still answers 400 rather than 403", async () => {
    const extend = await callExtendLease();
    expect(extend.status).toBe(400);
    expect(await extend.json()).toEqual({ error: "No email on file." });

    const moveOut = await callCheckMoveOut();
    expect(moveOut.status).toBe(400);
    expect(await moveOut.json()).toEqual({ error: "No email on file." });
  });
});
