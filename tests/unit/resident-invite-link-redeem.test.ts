import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A resident invite link is a PASTE-ABLE credential, so the only thing standing
 * between "whoever the link reached" and someone's portfolio is that redeeming
 * it grants nothing. These drive the real redeem path to prove that.
 *
 * The plan gate is mocked to REFUSE throughout: a resident is a person who
 * lives in the property, not a seat on the manager's plan, so a Free manager
 * must still be able to move their existing tenants across. Every co-manager
 * assertion here therefore doubles as proof the gate is still wired for the
 * kind that does need it.
 */
vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: vi.fn(async () => ({ ok: true, tier: "free" })),
}));
vi.mock("@/lib/co-manager-plan-access.server", () => ({
  managerPlanAllowsCoManagerInvites: () => false,
}));

import {
  mintInviteLink,
  redeemInviteLink,
  resolveResidentInviteClaim,
} from "@/lib/invite-links/invite-links.server";

type Link = {
  id: string;
  owner_user_id: string;
  kind: string;
  assigned_property_ids: string[];
  assigned_room_id: string | null;
  property_permissions: unknown;
  max_uses: number | null;
  used_count: number;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  label: string | null;
};

let link: Link;
/** Which of the link's properties the owner STILL holds, re-derived at redeem. */
let ownedPropertyIds: string[];
let existingClaimId: string | null;
let claimInsertError: { message: string; code?: string } | null;
const inserted: Record<string, Record<string, unknown>[]> = {};

function makeLink(overrides: Partial<Link> = {}): Link {
  return {
    id: "link-1",
    owner_user_id: "owner-1",
    kind: "resident",
    assigned_property_ids: ["prop-1"],
    assigned_room_id: null,
    property_permissions: {},
    max_uses: null,
    used_count: 0,
    expires_at: null,
    revoked_at: null,
    created_at: "2026-09-01T00:00:00.000Z",
    label: "Maple St",
    ...overrides,
  };
}

function makeDb(): SupabaseClient {
  const table = (name: string) => {
    const state: { filters: Record<string, unknown>; payload: Record<string, unknown> | null } = {
      filters: {},
      payload: null,
    };
    const result = () => {
      if (name === "resident_invite_claims") {
        if (state.payload) {
          if (claimInsertError) return { data: null, error: claimInsertError };
          return { data: { id: "claim-1" }, error: null };
        }
        return { data: existingClaimId ? { id: existingClaimId } : null, error: null };
      }
      if (name === "manager_property_records") {
        return {
          data: ownedPropertyIds.map((id) => ({ id, manager_user_id: link.owner_user_id })),
          error: null,
        };
      }
      if (name === "profiles") {
        return { data: { email: "Jane@Example.com ", full_name: "Jane Smith" }, error: null };
      }
      if (name === "manager_invite_links" && state.payload) {
        link.used_count = Number((state.payload as { used_count: number }).used_count);
        return { data: { id: link.id }, error: null };
      }
      if (name === "manager_invite_link_redemptions") return { data: null, error: null };
      return { data: null, error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (column: string, value: unknown) => {
        state.filters[column] = value;
        return q;
      },
      in: () => q,
      lt: () => q,
      order: () => q,
      limit: () => q,
      is: () => q,
      update: (payload: Record<string, unknown>) => {
        state.payload = payload;
        return q;
      },
      insert: (payload: Record<string, unknown>) => {
        state.payload = payload;
        (inserted[name] ??= []).push(payload);
        return q;
      },
      delete: () => ({ eq: () => ({ eq: async () => ({ data: null, error: null }) }) }),
      maybeSingle: async () => {
        if (name === "manager_invite_links" && !state.payload) return { data: { ...link }, error: null };
        const out = result();
        return { data: Array.isArray(out.data) ? (out.data[0] ?? null) : out.data, error: out.error };
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return q;
  };
  return { from: (name: string) => table(name) } as unknown as SupabaseClient;
}

beforeEach(() => {
  link = makeLink();
  ownedPropertyIds = ["prop-1"];
  existingClaimId = null;
  claimInsertError = null;
  for (const key of Object.keys(inserted)) delete inserted[key];
});

describe("redeeming a RESIDENT invite link", () => {
  it("files a claim and never an account_link_invites row", async () => {
    const result = await redeemInviteLink(makeDb(), { token: "t", redeemerUserId: "resident-1" });

    expect(result).toEqual({ ok: true, kind: "resident", claimId: "claim-1", alreadyRedeemed: false });
    // The co-manager table is what grants module access to a portfolio. A
    // paste-able link must never be able to reach it.
    expect(inserted.account_link_invites).toBeUndefined();
    expect(inserted.resident_invite_claims).toHaveLength(1);
  });

  it("grants nothing — the claim lands pending with no resident attached", async () => {
    await redeemInviteLink(makeDb(), { token: "t", redeemerUserId: "resident-1" });
    const claim = inserted.resident_invite_claims![0]!;

    expect(claim.status).toBe("pending");
    // No auto-matching: the claimant is not linked to any resident record until
    // a manager names one on the review screen.
    expect(claim.linked_application_id).toBeUndefined();
  });

  it("takes the manager and the property from the LINK, never the redeemer", async () => {
    await redeemInviteLink(makeDb(), { token: "t", redeemerUserId: "resident-1" });
    const claim = inserted.resident_invite_claims![0]!;

    expect(claim.owner_user_id).toBe("owner-1");
    expect(claim.property_id).toBe("prop-1");
    expect(claim.claimant_user_id).toBe("resident-1");
  });

  it("records the claimant's own authenticated email, normalized", async () => {
    await redeemInviteLink(makeDb(), { token: "t", redeemerUserId: "resident-1" });
    expect(inserted.resident_invite_claims![0]!.claimant_email).toBe("jane@example.com");
  });

  it("is NOT gated on the manager's plan — a Free manager can still migrate residents", async () => {
    const result = await redeemInviteLink(makeDb(), { token: "t", redeemerUserId: "resident-1" });
    expect(result.ok).toBe(true);
  });

  it("still refuses a CO-MANAGER link on that same Free plan", async () => {
    link = makeLink({ kind: "manager", property_permissions: { "prop-1": { leases: { read: true } } } });
    const result = await redeemInviteLink(makeDb(), { token: "t", redeemerUserId: "peer-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("hands back the existing claim instead of filing a second one", async () => {
    existingClaimId = "claim-existing";
    const result = await redeemInviteLink(makeDb(), { token: "t", redeemerUserId: "resident-1" });

    expect(result).toEqual({
      ok: true,
      kind: "resident",
      claimId: "claim-existing",
      alreadyRedeemed: true,
    });
    expect(inserted.resident_invite_claims).toBeUndefined();
    // And no use was burned on a re-open.
    expect(link.used_count).toBe(0);
  });

  it("refuses when the link points at a property its owner no longer manages", async () => {
    // The link was minted while the owner held prop-1; the house has since
    // changed hands, so the ownership lookup no longer returns it.
    ownedPropertyIds = [];

    const result = await redeemInviteLink(makeDb(), { token: "t", redeemerUserId: "resident-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
    expect(inserted.resident_invite_claims).toBeUndefined();
  });

  it("hands the use back when the claim insert fails", async () => {
    link = makeLink({ max_uses: 1 });
    claimInsertError = { message: "boom" };
    const result = await redeemInviteLink(makeDb(), { token: "t", redeemerUserId: "resident-1" });

    expect(result.ok).toBe(false);
    // A one-time link must not be left spent on a claim that never existed.
    expect(link.used_count).toBe(0);
  });

  it("refuses the owner's own link", async () => {
    const result = await redeemInviteLink(makeDb(), { token: "t", redeemerUserId: "owner-1" });
    expect(result.ok).toBe(false);
    expect(inserted.resident_invite_claims).toBeUndefined();
  });
});

describe("minting a RESIDENT invite link", () => {
  it("succeeds on a Free plan, where a co-manager link is refused", async () => {
    const db = makeDb();
    // `actorUserId`, not `ownerUserId`: a co-manager with Team edit may mint on
    // the owner's behalf (PRP-400), so the owner is resolved from the actor.
    const args = {
      actorUserId: "owner-1",
      assignedPropertyIds: ["prop-1"],
      propertyPermissions: {},
    };

    const asResident = await mintInviteLink(db, { ...args, kind: "resident" });
    const asManager = await mintInviteLink(db, { ...args, kind: "manager" });

    expect(asResident.ok).toBe(true);
    expect(asManager.ok).toBe(false);
    if (!asManager.ok) expect(asManager.status).toBe(403);
  });

  it("stores an EMPTY permission map, so a resident link carries no module grant", async () => {
    await mintInviteLink(makeDb(), {
      actorUserId: "owner-1",
      kind: "resident",
      assignedPropertyIds: ["prop-1"],
      // A caller trying to smuggle co-manager permissions onto a resident link.
      propertyPermissions: { "prop-1": { leases: { read: true, edit: true } } },
    });
    const row = inserted.manager_invite_links![0]!;
    expect(row.property_permissions).toEqual({});
  });

  it("mints a vendor link with no property grant and no co-manager plan gate", async () => {
    const result = await mintInviteLink(makeDb(), {
      actorUserId: "owner-1",
      kind: "vendor",
      assignedPropertyIds: [],
      propertyPermissions: {},
    });
    expect(result.ok).toBe(true);
    const row = inserted.manager_invite_links![0]!;
    expect(row.kind).toBe("vendor");
    expect(row.assigned_property_ids).toEqual([]);
    expect(row.property_permissions).toEqual({});
  });
});

describe("resolving a claim", () => {
  /**
   * `linkedApplicationId` arrives in a REQUEST BODY. Approving writes the
   * claimant's email onto that resident record, so an unchecked id would let
   * any manager point a stranger's tenancy at their own claimant — the exact
   * shape of the ownership bug `POST /api/property-records` was hardened
   * against. These drive the real path.
   */
  function claimDb(opts: {
    ownedApplicationIds: string[];
    ownershipReadFails?: boolean;
    writes: Record<string, Record<string, unknown>[]>;
  }): SupabaseClient {
    const table = (name: string) => {
      const state: { filters: Record<string, unknown>; payload: Record<string, unknown> | null } = {
        filters: {},
        payload: null,
      };
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (column: string, value: unknown) => {
          state.filters[column] = value;
          return q;
        },
        update: (payload: Record<string, unknown>) => {
          state.payload = payload;
          // `state.filters` by REFERENCE, not a copy: the real code chains
          // `.update(...).eq(...).eq(...)`, so the filters that scope the write
          // are added AFTER update() is called. Snapshotting here would record
          // an empty object and silently assert nothing.
          (opts.writes[name] ??= []).push({ ...payload, __filters: state.filters });
          return q;
        },
        maybeSingle: async () => {
          if (name === "manager_application_records") {
            if (state.payload) return { data: { id: state.filters.id }, error: null };
            if (opts.ownershipReadFails) return { data: null, error: { message: "read failed" } };
            return {
              data: opts.ownedApplicationIds.includes(String(state.filters.id))
                ? { id: state.filters.id }
                : null,
              error: null,
            };
          }
          if (name === "resident_invite_claims") {
            return {
              data: {
                id: "claim-1",
                link_id: "link-1",
                claimant_user_id: "resident-1",
                claimant_email: "jane@example.com",
                claimant_name: "Jane Smith",
                property_id: "prop-1",
                room_id: null,
                note: null,
                status: state.payload?.status ?? "pending",
                linked_application_id: state.payload?.linked_application_id ?? null,
                created_at: "2026-09-07T00:00:00.000Z",
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(resolve),
      };
      return q;
    };
    return { from: (name: string) => table(name) } as unknown as SupabaseClient;
  }

  it("refuses to approve onto a resident record the manager does not own", async () => {
    const writes: Record<string, Record<string, unknown>[]> = {};
    const result = await resolveResidentInviteClaim(
      claimDb({ ownedApplicationIds: ["mine-1"], writes }),
      {
        ownerUserId: "owner-1",
        claimId: "claim-1",
        status: "approved",
        linkedApplicationId: "someone-elses-1",
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
    // And crucially, the victim's resident email was never rewritten.
    expect(writes.manager_application_records).toBeUndefined();
    expect(writes.resident_invite_claims).toBeUndefined();
  });

  it("treats a MISSING resident record as unowned rather than approving it", async () => {
    const writes: Record<string, Record<string, unknown>[]> = {};
    const result = await resolveResidentInviteClaim(claimDb({ ownedApplicationIds: [], writes }), {
      ownerUserId: "owner-1",
      claimId: "claim-1",
      status: "approved",
      linkedApplicationId: "does-not-exist",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("is a 500 when the ownership read itself fails — never a silent refusal or a pass", async () => {
    const writes: Record<string, Record<string, unknown>[]> = {};
    const result = await resolveResidentInviteClaim(
      claimDb({ ownedApplicationIds: ["mine-1"], ownershipReadFails: true, writes }),
      {
        ownerUserId: "owner-1",
        claimId: "claim-1",
        status: "approved",
        linkedApplicationId: "mine-1",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(500);
    expect(writes.manager_application_records).toBeUndefined();
  });

  it("approves onto the manager's own record and records the pairing on the claim", async () => {
    const writes: Record<string, Record<string, unknown>[]> = {};
    const result = await resolveResidentInviteClaim(
      claimDb({ ownedApplicationIds: ["mine-1"], writes }),
      {
        ownerUserId: "owner-1",
        claimId: "claim-1",
        status: "approved",
        linkedApplicationId: "mine-1",
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claim.status).toBe("approved");
      expect(result.claim.linkedApplicationId).toBe("mine-1");
      expect(result.claim.claimantEmail).toBe("jane@example.com");
    }
    // The claim update is owner-scoped, so the id in the body is never the
    // only thing standing between a caller and someone else's claim.
    const claimWrite = writes.resident_invite_claims?.[0];
    expect((claimWrite?.__filters as Record<string, unknown>).owner_user_id).toBe("owner-1");
  });

  it("does NOT write resident_email server-side — the browser mirror would revert it", async () => {
    // Verified against the dev project: a server-side write to
    // `manager_application_records.resident_email` is overwritten by the
    // manager browser's next mirror sync (the row's `updated_at` advances
    // while the email snaps back). The pairing therefore belongs to the client
    // storage layer that owns the row, and this function must not race it.
    const writes: Record<string, Record<string, unknown>[]> = {};
    await resolveResidentInviteClaim(claimDb({ ownedApplicationIds: ["mine-1"], writes }), {
      ownerUserId: "owner-1",
      claimId: "claim-1",
      status: "approved",
      linkedApplicationId: "mine-1",
    });

    expect(writes.manager_application_records).toBeUndefined();
  });

  it("refuses to approve without naming a resident at all", async () => {
    const writes: Record<string, Record<string, unknown>[]> = {};
    const result = await resolveResidentInviteClaim(claimDb({ ownedApplicationIds: [], writes }), {
      ownerUserId: "owner-1",
      claimId: "claim-1",
      status: "approved",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("dismissing needs no resident and rewrites no email", async () => {
    const writes: Record<string, Record<string, unknown>[]> = {};
    const result = await resolveResidentInviteClaim(claimDb({ ownedApplicationIds: [], writes }), {
      ownerUserId: "owner-1",
      claimId: "claim-1",
      status: "rejected",
    });

    expect(result.ok).toBe(true);
    expect(writes.manager_application_records).toBeUndefined();
  });
});
