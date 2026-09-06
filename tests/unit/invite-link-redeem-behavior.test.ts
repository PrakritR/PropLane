import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The redemption path, driven for real.
 *
 * Every other invite-link test greps the source, so none of them noticed that the
 * insert omitted `tab_kind` — a `not null` column with no default — which made
 * every first redemption a 23502 that had already spent the link's only use.
 */
vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: vi.fn(async () => ({ ok: true, tier: "pro" })),
}));
vi.mock("@/lib/co-manager-plan-access.server", () => ({
  managerPlanAllowsCoManagerInvites: () => true,
}));

import { redeemInviteLink } from "@/lib/invite-links/invite-links.server";

type Link = {
  id: string;
  owner_user_id: string;
  kind: string;
  assigned_property_ids: string[];
  property_permissions: unknown;
  max_uses: number | null;
  used_count: number;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  label: string | null;
};

let link: Link;
let inviteInsertError: { message: string; code?: string } | null;
const inserted: Record<string, unknown[]> = {};
const linkUpdates: Record<string, unknown>[] = [];
const deletes: string[] = [];

function makeLink(overrides: Partial<Link> = {}): Link {
  return {
    id: "link-1",
    owner_user_id: "owner-1",
    kind: "manager",
    assigned_property_ids: ["prop-1"],
    property_permissions: { "prop-1": { leases: { read: true } } },
    max_uses: 1,
    used_count: 0,
    expires_at: null,
    revoked_at: null,
    created_at: "2026-09-01T00:00:00.000Z",
    label: null,
    ...overrides,
  };
}

/** Only the tables and verbs `redeemInviteLink` actually touches. */
function makeDb(): SupabaseClient {
  const table = (name: string) => {
    const state: { filters: Record<string, unknown>; payload: Record<string, unknown> | null } = {
      filters: {},
      payload: null,
    };
    const rowsFor = (): Record<string, unknown>[] => {
      if (name === "manager_property_records") {
        return link.assigned_property_ids.map((id) => ({ id, manager_user_id: link.owner_user_id }));
      }
      if (name === "profiles") return [{ axis_id: "AX-1", full_name: "Someone" }];
      return [];
    };
    const result = () => {
      if (name === "account_link_invites" && state.payload) {
        if (inviteInsertError) return { data: null, error: inviteInsertError };
        return { data: { id: "invite-1" }, error: null };
      }
      if (state.payload && name === "manager_invite_link_redemptions") {
        return { data: null, error: null };
      }
      if (name === "manager_invite_links" && state.payload) {
        // The conditional spend only matches when used_count is still what was read.
        linkUpdates.push({ ...state.payload });
        if (state.filters.used_count !== undefined && state.filters.used_count !== link.used_count) {
          return { data: null, error: null };
        }
        link.used_count = Number((state.payload as { used_count: number }).used_count);
        return { data: { id: link.id }, error: null };
      }
      const rows = rowsFor();
      return { data: rows.length ? rows : null, error: null };
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
      delete: () => {
        deletes.push(name);
        return { eq: () => ({ eq: async () => ({ data: null, error: null }) }) };
      },
      maybeSingle: async () => {
        // A snapshot, like PostgREST returns — never the live row the update then mutates.
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
  inviteInsertError = null;
  for (const key of Object.keys(inserted)) delete inserted[key];
  linkUpdates.length = 0;
  deletes.length = 0;
});

describe("redeeming a manager invite link", () => {
  it("creates the addressed invite with the tab_kind the column requires", async () => {
    const result = await redeemInviteLink(makeDb(), { token: "t", redeemerUserId: "peer-1" });

    expect(result).toEqual({ ok: true, inviteId: "invite-1", alreadyRedeemed: false });
    const invite = inserted.account_link_invites?.[0] as Record<string, unknown>;
    expect(invite.tab_kind).toBe("manager");
    expect(invite.status).toBe("pending");
    // The scope comes off the stored link, never the redeemer.
    expect(invite.assigned_property_ids).toEqual(["prop-1"]);
    expect(link.used_count).toBe(1);
  });

  it("hands the use back when the invite insert fails, so a one-time link survives", async () => {
    inviteInsertError = { message: "boom" };

    const result = await redeemInviteLink(makeDb(), { token: "t", redeemerUserId: "peer-1" });

    expect(result.ok).toBe(false);
    expect(link.used_count).toBe(0);
    expect(deletes).toContain("manager_invite_link_redemptions");
  });
});

describe("a link that cannot be honoured", () => {
  it("refuses a vendor link instead of minting co-manager access", async () => {
    link = makeLink({ kind: "vendor" });

    const result = await redeemInviteLink(makeDb(), { token: "t", redeemerUserId: "peer-1" });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(inserted.account_link_invites).toBeUndefined();
  });

  it("refuses it BEFORE spending a use", async () => {
    link = makeLink({ kind: "vendor" });

    await redeemInviteLink(makeDb(), { token: "t", redeemerUserId: "peer-1" });

    expect(link.used_count).toBe(0);
    expect(linkUpdates).toHaveLength(0);
  });
});
