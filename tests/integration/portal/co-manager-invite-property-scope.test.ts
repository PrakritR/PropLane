import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

/**
 * Cross-tenant co-manager takeover regression.
 *
 * `assigned_property_ids` was stored verbatim from the request body and never
 * checked against the inviter's ownership. A manager could harvest a victim's
 * property id from the public listing feed, invite a second account they
 * control onto it, accept, and then pass every `assertCoManagerModuleAccess`
 * gate on that property — read leases/financials/documents, edit the listing,
 * or delete it. An empty permissions object resolves to a *full* grant, so a
 * forged link with `{}` yields maximum access.
 *
 * The PATCH path was worse: either party could rewrite the list, so an invitee
 * could widen their own grant after the fact.
 */

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/manager-access-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-access-server")>();
  return {
    ...actual,
    ensureProfileProplaneId: vi.fn().mockResolvedValue({
      ok: true,
      proplaneId: "AXIS-INVITER",
      fullName: null,
      email: "inviter@test.com",
      role: "manager",
    }),
    getManagerPurchaseSku: vi.fn().mockResolvedValue({ tier: "free", billing: "free" }),
  };
});

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { POST as createAccountLink } from "@/app/api/pro/account-links/route";
import { PATCH as patchAccountLink } from "@/app/api/pro/account-links/[inviteId]/route";

const INVITER = "mgr-inviter";
const INVITEE = "mgr-invitee";
const OWNED = "prop-owned-by-inviter";
const VICTIM = "prop-owned-by-victim";

/** Session client: only ever used to resolve the caller and their portal role. */
function sessionClientFor(userId: string | null, role: "manager" | "resident" = "manager") {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: userId ? { id: userId } : null } }) },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { role }, error: null }) })),
          maybeSingle: vi.fn().mockResolvedValue({ data: { role }, error: null }),
        })),
      })),
    })),
  } as never;
}

/**
 * Service-role client. `manager_property_records` answers only with the rows
 * the named manager actually owns — the real ownership semantics. Any other
 * table resolves empty so the handler stops soon after the gate under test.
 */
function serviceClient(ownedByInviter: string[], invite?: Record<string, unknown>) {
  const propertyRows = (managerUserId: string, ids: string[]) =>
    managerUserId === INVITER ? ownedByInviter.filter((id) => ids.includes(id)).map((id) => ({ id })) : [];

  return {
    from: vi.fn((table: string) => {
      if (table === "manager_property_records") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn((_col: string, managerUserId: string) => ({
              in: vi.fn((_idCol: string, ids: string[]) =>
                Promise.resolve({ data: propertyRows(managerUserId, ids), error: null }),
              ),
            })),
          })),
        };
      }
      if (table === "profiles") {
        return {
          select: vi.fn(() => ({
            in: vi.fn(() => Promise.resolve({ data: [], error: null })),
            eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })),
          })),
        };
      }
      if (table === "account_link_invites") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: invite ?? null, error: null }) })),
          })),
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: invite ?? null, error: null }) })),
              })),
            })),
          })),
        };
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })),
        })),
      };
    }),
  } as never;
}

const acceptedInvite = {
  id: "link-1",
  status: "accepted",
  inviter_user_id: INVITER,
  invitee_user_id: INVITEE,
  assigned_property_ids: [OWNED],
  payout_percent_for_manager: 15,
  property_co_manager_permissions: {},
  co_manager_permissions: {},
};

const pendingInvite = (assignedPropertyIds: string[]) => ({
  ...acceptedInvite,
  status: "pending",
  assigned_property_ids: assignedPropertyIds,
});

describe("co-manager invite property scope", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("POST /api/pro/account-links", () => {
    it("rejects an invite naming a property the inviter does not own", async () => {
      vi.mocked(createSupabaseServerClient).mockResolvedValue(sessionClientFor(INVITER));
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(serviceClient([OWNED]));

      const res = await createAccountLink(
        jsonRequest("http://localhost/api/pro/account-links", {
          method: "POST",
          body: {
            inviteeAxisId: "AXIS-INVITEE",
            assignedPropertyIds: [VICTIM],
            propertyCoManagerPermissions: {},
          },
        }),
      );
      const { status, data } = await parseJsonResponse<{ error?: string }>(res);
      expect(status).toBe(403);
      expect(data.error).toMatch(/only assign properties you manage/i);
    });

    it("rejects a mixed list that smuggles one unowned id alongside owned ones", async () => {
      vi.mocked(createSupabaseServerClient).mockResolvedValue(sessionClientFor(INVITER));
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(serviceClient([OWNED]));

      const res = await createAccountLink(
        jsonRequest("http://localhost/api/pro/account-links", {
          method: "POST",
          body: {
            inviteeAxisId: "AXIS-INVITEE",
            assignedPropertyIds: [OWNED, VICTIM],
            propertyCoManagerPermissions: {},
          },
        }),
      );
      expect(res.status).toBe(403);
    });

    it("lets a fully-owned list past the ownership gate", async () => {
      vi.mocked(createSupabaseServerClient).mockResolvedValue(sessionClientFor(INVITER));
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(serviceClient([OWNED]));

      const res = await createAccountLink(
        jsonRequest("http://localhost/api/pro/account-links", {
          method: "POST",
          body: {
            inviteeAxisId: "AXIS-INVITEE",
            assignedPropertyIds: [OWNED],
            propertyCoManagerPermissions: {},
          },
        }),
      );
      // It fails later on the stubbed profile lookup — the point is that the
      // ownership gate did not reject an id the inviter genuinely owns.
      expect(res.status).not.toBe(403);
    });
  });

  describe("PATCH /api/pro/account-links/[inviteId]", () => {
    const params = Promise.resolve({ inviteId: "link-1" });

    it("refuses to let the invitee rewrite the property scope", async () => {
      vi.mocked(createSupabaseServerClient).mockResolvedValue(sessionClientFor(INVITEE));
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(serviceClient([OWNED], acceptedInvite));

      const res = await patchAccountLink(
        jsonRequest("http://localhost/api/pro/account-links/link-1", {
          method: "PATCH",
          body: { assignedPropertyIds: [OWNED, VICTIM] },
        }),
        { params },
      );
      const { status, data } = await parseJsonResponse<{ error?: string }>(res);
      expect(status).toBe(403);
      expect(data.error).toMatch(/only the primary manager can change the property scope/i);
    });

    it("refuses to let the inviter widen the scope to a property they do not own", async () => {
      vi.mocked(createSupabaseServerClient).mockResolvedValue(sessionClientFor(INVITER));
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(serviceClient([OWNED], acceptedInvite));

      const res = await patchAccountLink(
        jsonRequest("http://localhost/api/pro/account-links/link-1", {
          method: "PATCH",
          body: { assignedPropertyIds: [VICTIM] },
        }),
        { params },
      );
      const { status, data } = await parseJsonResponse<{ error?: string }>(res);
      expect(status).toBe(403);
      expect(data.error).toMatch(/only assign properties you manage/i);
    });

    /**
     * The create-time gate only covers rows written after it shipped. An invite
     * forged before the deploy is still pending, so accept must re-derive the
     * inviter's ownership rather than trusting the stored list.
     */
    it("rejects accepting an invite that names a property the inviter does not own", async () => {
      vi.mocked(createSupabaseServerClient).mockResolvedValue(sessionClientFor(INVITEE));
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(serviceClient([OWNED], pendingInvite([VICTIM])));

      const res = await patchAccountLink(
        jsonRequest("http://localhost/api/pro/account-links/link-1", { method: "PATCH", body: { action: "accept" } }),
        { params },
      );
      const { status, data } = await parseJsonResponse<{ error?: string }>(res);
      expect(status).toBe(403);
      expect(data.error).toMatch(/does not manage/i);
    });

    it("rejects the whole accept rather than silently dropping the unowned id", async () => {
      vi.mocked(createSupabaseServerClient).mockResolvedValue(sessionClientFor(INVITEE));
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
        serviceClient([OWNED], pendingInvite([OWNED, VICTIM])),
      );

      const res = await patchAccountLink(
        jsonRequest("http://localhost/api/pro/account-links/link-1", { method: "PATCH", body: { action: "accept" } }),
        { params },
      );
      expect(res.status).toBe(403);
    });

    it("still accepts an invite whose properties the inviter owns", async () => {
      vi.mocked(createSupabaseServerClient).mockResolvedValue(sessionClientFor(INVITEE));
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(serviceClient([OWNED], pendingInvite([OWNED])));

      const res = await patchAccountLink(
        jsonRequest("http://localhost/api/pro/account-links/link-1", { method: "PATCH", body: { action: "accept" } }),
        { params },
      );
      expect(res.status).toBe(200);
    });

    it("still lets the inviter narrow the scope to properties they own", async () => {
      vi.mocked(createSupabaseServerClient).mockResolvedValue(sessionClientFor(INVITER));
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(serviceClient([OWNED], acceptedInvite));

      const res = await patchAccountLink(
        jsonRequest("http://localhost/api/pro/account-links/link-1", {
          method: "PATCH",
          body: { assignedPropertyIds: [OWNED] },
        }),
        { params },
      );
      expect(res.status).not.toBe(403);
    });
  });
});
