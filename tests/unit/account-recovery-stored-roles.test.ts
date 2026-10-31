import { expect, it, vi } from "vitest";
const cancelSubscription = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/delete-portal-account", () => ({ cancelActiveManagerSubscription: cancelSubscription }));
vi.mock("@/lib/sms/cancel-number-subscription.server", () => ({ cancelNumberSubscriptionForAccount: vi.fn() }));
import { schedulePortalAccountDeletion } from "@/lib/auth/account-recovery.server";

function dbFor(legacy: string, roles: string[], roleError: { message: string } | null = null, pending = true) {
  const request = { id: "request", user_id: "user", email: "person@example.test", portal: "manager", state: "retained", expires_at: "2099-01-01T00:00:00Z", plan: { complete: roles.filter((r) => r !== "manager").length === 0 } };
  return {
    auth: { admin: { getUserById: async () => ({ data: { user: { email: "person@example.test" } }, error: null }) } },
    from(table: string) {
      const q = { select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
        maybeSingle: async () => ({ data: table === "profiles" ? { role: legacy } : pending ? request : null, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: roles.map((role) => ({ role })), error: roleError }).then(resolve) };
      return q;
    },
  };
}

it("does not regrant a stale admin role and signs out the last manager", async () => {
  const result = await schedulePortalAccountDeletion(dbFor("admin", ["manager"]) as never, "user", "manager");
  expect(result).toMatchObject({ signedOut: true, redirectTo: "/auth/sign-in?deleted=1" });
});
it("preserves a genuinely stored admin role", async () => {
  const result = await schedulePortalAccountDeletion(dbFor("admin", ["manager", "admin"]) as never, "user", "manager");
  expect(result).toMatchObject({ signedOut: false, redirectTo: "/admin/dashboard" });
});
it("fails closed if stored roles cannot be read", async () => {
  await expect(schedulePortalAccountDeletion(dbFor("manager", [], { message: "roles unavailable" }) as never, "user", "manager")).rejects.toThrow("roles unavailable");
});

it("allows legacy-only self-deletion without granting a role", async () => {
  cancelSubscription.mockRejectedValueOnce(new Error("reached cancellation"));
  await expect(schedulePortalAccountDeletion(dbFor("manager", [], null, false) as never, "user", "manager")).rejects.toThrow("reached cancellation");
  await expect(schedulePortalAccountDeletion(dbFor("resident", [], null, false) as never, "user", "manager")).rejects.toThrow("does not have access");
});
