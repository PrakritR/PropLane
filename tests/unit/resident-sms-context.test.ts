/**
 * The resident SMS agent's security choke point. Over SMS the only identity
 * signal is the `From` header, so these tests pin the three facts that must ALL
 * hold before any resident row becomes readable, and prove each one fails
 * closed on its own.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/resident-manager-scope", () => ({
  managerIdsOwningResident: vi.fn(),
}));
vi.mock("@/lib/resident-portal-access", () => ({
  loadResidentPortalAccessState: vi.fn(),
}));
vi.mock("@/lib/manager-access-server", () => ({
  getManagerSubscriptionTierByManagerId: vi.fn(),
}));

import { resolveResidentSmsAgentContext } from "@/lib/tools/resident-sms-context";
import { residentManagerIds, type ResidentAgentContext } from "@/lib/tools/resident-context";
import { managerIdsOwningResident } from "@/lib/resident-manager-scope";
import { loadResidentPortalAccessState } from "@/lib/resident-portal-access";
import { getManagerSubscriptionTierByManagerId } from "@/lib/manager-access-server";

const RESIDENT_ID = "11111111-1111-1111-1111-111111111111";
const OWNER_MANAGER = "22222222-2222-2222-2222-222222222222";
const OTHER_MANAGER = "33333333-3333-3333-3333-333333333333";
const PHONE = "+14155550142";

type ProfileRow = {
  id: string;
  email: string | null;
  phone: string | null;
  phone_verified_at: string | null;
  role: string | null;
  manager_id: string | null;
};

function verifiedProfile(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: RESIDENT_ID,
    email: "ana@example.com",
    phone: PHONE,
    phone_verified_at: "2026-08-01T00:00:00.000Z",
    role: "resident",
    manager_id: OWNER_MANAGER,
    ...overrides,
  };
}

let notCalls: [string, string, unknown][] = [];
let limitCalls: number[] = [];

function makeDb(opts: {
  profiles?: ProfileRow[];
  profilesError?: boolean;
  roles?: string[];
  rolesError?: boolean;
}) {
  const { profiles = [], profilesError = false, roles = ["resident"], rolesError = false } = opts;
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "profiles") {
        // Mirrors the real chain: .in(...).not("phone_verified_at","is",null).limit(2)
        // The `.not` link is load-bearing — see the truncation test below.
        return {
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockReturnValue({
              not: vi.fn().mockImplementation((col: string, op: string, val: unknown) => {
                notCalls.push([col, op, val]);
                return {
                  limit: vi.fn().mockImplementation((n: number) => {
                    limitCalls.push(n);
                    if (profilesError) return Promise.resolve({ data: null, error: { message: "boom" } });
                    // The DB applies the verified predicate before the limit.
                    const verifiedOnly = profiles.filter((p) => p.phone_verified_at != null);
                    return Promise.resolve({ data: verifiedOnly.slice(0, n), error: null });
                  }),
                };
              }),
            }),
          }),
        };
      }
      if (table === "profile_roles") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue(
              rolesError
                ? { data: null, error: { message: "boom" } }
                : { data: roles.map((role) => ({ role })), error: null },
            ),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  notCalls = [];
  limitCalls = [];
  vi.mocked(managerIdsOwningResident).mockResolvedValue([OWNER_MANAGER]);
  vi.mocked(loadResidentPortalAccessState).mockResolvedValue({
    leaseAccessUnlocked: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(getManagerSubscriptionTierByManagerId).mockResolvedValue(null);
});

describe("resolveResidentSmsAgentContext", () => {
  it("binds a verified resident texting their own manager's work number", async () => {
    vi.mocked(managerIdsOwningResident).mockResolvedValue([OTHER_MANAGER, OWNER_MANAGER]);
    vi.mocked(getManagerSubscriptionTierByManagerId).mockResolvedValue("paid");
    vi.mocked(loadResidentPortalAccessState).mockResolvedValue({
      leaseAccessUnlocked: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const res = await resolveResidentSmsAgentContext(makeDb({
      profiles: [verifiedProfile({ manager_id: OTHER_MANAGER })],
    }), {
      fromPhone: PHONE,
      ownerManagerUserId: OWNER_MANAGER,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // userId is the binding every resident tool scopes on. It must come from the
    // matched profile, never from anything the inbound message carried.
    expect(res.ctx.userId).toBe(RESIDENT_ID);
    expect(res.ctx.email).toBe("ana@example.com");
    expect(res.ctx.landlordId).toBe(RESIDENT_ID);
    expect(res.ctx.managerIds).toEqual([OTHER_MANAGER, OWNER_MANAGER]);
    expect(res.ctx.activeManagerId).toBe(OWNER_MANAGER);
    expect(res.ctx.managerTier).toBe("paid");
    expect(res.ctx.phase).toBe("application");
    expect(getManagerSubscriptionTierByManagerId).toHaveBeenCalledWith(OWNER_MANAGER);
    expect(loadResidentPortalAccessState).toHaveBeenCalledWith({
      userId: RESIDENT_ID,
      role: "resident",
      email: "ana@example.com",
      managerSubscriptionTier: null,
      managerUserId: OWNER_MANAGER,
    });
  });

  it("refuses an unverified number even when the profile matches", async () => {
    const res = await resolveResidentSmsAgentContext(
      makeDb({ profiles: [verifiedProfile({ phone_verified_at: null })] }),
      { fromPhone: PHONE, ownerManagerUserId: OWNER_MANAGER },
    );
    expect(res).toEqual({ ok: false, reason: "no_verified_profile" });
  });

  it("refuses when the texted work number belongs to a manager this resident is not linked to", async () => {
    // The tenant binding: resident of manager A texting manager B.
    vi.mocked(managerIdsOwningResident).mockResolvedValue([OTHER_MANAGER]);
    const res = await resolveResidentSmsAgentContext(makeDb({ profiles: [verifiedProfile()] }), {
      fromPhone: PHONE,
      ownerManagerUserId: OWNER_MANAGER,
    });
    expect(res).toEqual({ ok: false, reason: "manager_not_linked" });
  });

  it("fails closed when two accounts claim the same verified number", async () => {
    const res = await resolveResidentSmsAgentContext(
      makeDb({
        profiles: [verifiedProfile(), verifiedProfile({ id: "44444444-4444-4444-4444-444444444444" })],
      }),
      { fromPhone: PHONE, ownerManagerUserId: OWNER_MANAGER },
    );
    expect(res).toEqual({ ok: false, reason: "no_verified_profile" });
  });

  it("refuses an account that is not a resident", async () => {
    const res = await resolveResidentSmsAgentContext(
      makeDb({ profiles: [verifiedProfile({ role: "manager" })], roles: ["manager"] }),
      { fromPhone: PHONE, ownerManagerUserId: OWNER_MANAGER },
    );
    expect(res).toEqual({ ok: false, reason: "not_a_resident" });
  });

  it("honours profile_roles over a stale legacy profiles.role for a multi-role account", async () => {
    // Created as a manager, later became a resident somewhere.
    const res = await resolveResidentSmsAgentContext(
      makeDb({ profiles: [verifiedProfile({ role: "manager" })], roles: ["manager", "resident"] }),
      { fromPhone: PHONE, ownerManagerUserId: OWNER_MANAGER },
    );
    expect(res.ok).toBe(true);
  });

  it("fails closed when the profile lookup errors", async () => {
    const res = await resolveResidentSmsAgentContext(makeDb({ profilesError: true }), {
      fromPhone: PHONE,
      ownerManagerUserId: OWNER_MANAGER,
    });
    expect(res).toEqual({ ok: false, reason: "lookup_failed" });
  });

  it("fails closed when the role lookup errors", async () => {
    const res = await resolveResidentSmsAgentContext(
      makeDb({ profiles: [verifiedProfile()], rolesError: true }),
      { fromPhone: PHONE, ownerManagerUserId: OWNER_MANAGER },
    );
    expect(res).toEqual({ ok: false, reason: "lookup_failed" });
  });

  it("rejects a missing owner manager id rather than resolving unscoped", async () => {
    const res = await resolveResidentSmsAgentContext(makeDb({ profiles: [verifiedProfile()] }), {
      fromPhone: PHONE,
      ownerManagerUserId: "   ",
    });
    expect(res).toEqual({ ok: false, reason: "invalid_phone" });
  });

  it("rejects an unparseable From header", async () => {
    const res = await resolveResidentSmsAgentContext(makeDb({}), {
      fromPhone: "not-a-phone",
      ownerManagerUserId: OWNER_MANAGER,
    });
    expect(res).toEqual({ ok: false, reason: "invalid_phone" });
  });

  it("applies the verified filter in the query so a page limit cannot mask a duplicate", async () => {
    // Regression: the guard used to fetch .limit(10) and filter in JS, so an
    // 11th matching row was never fetched. A page holding exactly one verified
    // profile then passed the ambiguity check while a second verified profile
    // for the same number existed. The predicate must be pushed to the DB.
    const many: ProfileRow[] = [
      ...Array.from({ length: 10 }, (_, i) =>
        verifiedProfile({ id: `unverified-${i}`, phone_verified_at: null }),
      ),
      verifiedProfile({ id: RESIDENT_ID }),
      verifiedProfile({ id: "55555555-5555-5555-5555-555555555555" }),
    ];
    const res = await resolveResidentSmsAgentContext(makeDb({ profiles: many }), {
      fromPhone: PHONE,
      ownerManagerUserId: OWNER_MANAGER,
    });
    expect(notCalls).toContainEqual(["phone_verified_at", "is", null]);
    // Two is enough to detect ambiguity and cannot hide a third.
    expect(limitCalls).toEqual([2]);
    expect(res).toEqual({ ok: false, reason: "no_verified_profile" });
  });

  it("matches a profile stored in an un-normalized display format", async () => {
    const res = await resolveResidentSmsAgentContext(
      makeDb({ profiles: [verifiedProfile({ phone: "(415) 555-0142" })] }),
      { fromPhone: PHONE, ownerManagerUserId: OWNER_MANAGER },
    );
    expect(res.ok).toBe(true);
  });
});

describe("residentManagerIds", () => {
  function context(managerIds: string[], activeManagerId?: string): ResidentAgentContext {
    return { managerIds, activeManagerId } as ResidentAgentContext;
  }

  it("preserves every linked manager for signed-in portal contexts", () => {
    expect(residentManagerIds(context([OWNER_MANAGER, OTHER_MANAGER]))).toEqual([
      OWNER_MANAGER,
      OTHER_MANAGER,
    ]);
  });

  it("narrows SMS to the texted owner and fails closed for an unlinked active manager", () => {
    expect(residentManagerIds(context([OWNER_MANAGER, OTHER_MANAGER], OWNER_MANAGER))).toEqual([
      OWNER_MANAGER,
    ]);
    expect(
      residentManagerIds(
        context([OTHER_MANAGER], OWNER_MANAGER),
      ),
    ).toEqual([]);
  });
});
