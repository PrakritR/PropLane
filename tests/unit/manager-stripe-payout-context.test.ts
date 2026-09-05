import { describe, expect, it } from "vitest";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveStripePayoutContext } from "@/lib/auth/manager-stripe-payout-access.server";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

/**
 * This decides which profile's Connect account a bank change lands on, so every
 * uncertain answer has to be a refusal. A count query that errored used to read
 * as "owns nothing", which re-classified an owner as somebody's co-manager and
 * pointed their onboarding at another manager's payout account.
 */
function makeDb(opts: {
  propertyCount?: number;
  propertyError?: boolean;
  inviters?: string[];
  linkError?: boolean;
}): ServiceClient {
  return {
    from: (table: string) => {
      if (table === "manager_property_records") {
        const q = {
          select: () => q,
          eq: async () => ({
            count: opts.propertyCount ?? 0,
            error: opts.propertyError ? { message: "down" } : null,
          }),
        };
        return q;
      }
      const rows = (opts.inviters ?? []).map((id) => ({
        inviter_user_id: id,
        assigned_property_ids: ["prop-1"],
        property_co_manager_permissions: { "prop-1": { bankAccount: { edit: true } } },
        co_manager_permissions: null,
      }));
      const result = { data: rows, error: opts.linkError ? { message: "down" } : null };
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      return q;
    },
  } as unknown as ServiceClient;
}

describe("resolveStripePayoutContext", () => {
  it("routes an owner to their own account", async () => {
    const context = await resolveStripePayoutContext(makeDb({ propertyCount: 3 }), "owner-1");
    expect(context).toEqual({
      payoutOwnerUserId: "owner-1",
      canEditBankAccount: true,
      isCoManagerForPayout: false,
    });
  });

  it("lets a brand-new manager with no listings onboard their OWN account", async () => {
    const context = await resolveStripePayoutContext(makeDb({ propertyCount: 0 }), "new-manager");
    expect(context.payoutOwnerUserId).toBe("new-manager");
    expect(context.canEditBankAccount).toBe(true);
  });

  it("refuses rather than reclassifying an owner when the property read fails", async () => {
    const context = await resolveStripePayoutContext(makeDb({ propertyError: true }), "owner-1");
    expect(context.payoutOwnerUserId).toBe("");
    expect(context.canEditBankAccount).toBe(false);
    expect(context.unresolvedReason).toBe("lookup_failed");
  });

  it("refuses rather than picking an arbitrary owner for a two-owner co-manager", async () => {
    const context = await resolveStripePayoutContext(
      makeDb({ propertyCount: 0, inviters: ["owner-a", "owner-b"] }),
      "co-1",
    );
    expect(context.payoutOwnerUserId).toBe("");
    expect(context.canEditBankAccount).toBe(false);
    expect(context.unresolvedReason).toBe("ambiguous_owner");
  });

  it("resolves the single owner a co-manager is linked to", async () => {
    const context = await resolveStripePayoutContext(
      makeDb({ propertyCount: 0, inviters: ["owner-a"] }),
      "co-1",
    );
    expect(context.payoutOwnerUserId).toBe("owner-a");
    expect(context.isCoManagerForPayout).toBe(true);
    expect(context.canEditBankAccount).toBe(true);
  });

  it("fails closed when the co-manager link read fails", async () => {
    const context = await resolveStripePayoutContext(
      makeDb({ propertyCount: 0, linkError: true }),
      "co-1",
    );
    expect(context.payoutOwnerUserId).toBe("");
    expect(context.unresolvedReason).toBe("lookup_failed");
  });
});
