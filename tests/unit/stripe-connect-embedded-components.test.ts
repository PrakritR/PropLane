/**
 * Security-review follow-up (PLAN-0920-0853 payouts review, item 2):
 * `notification_banner` is granted to a co-manager at the "read" level, so
 * `createAccountSession` must enable ONLY the one requested embedded
 * component — never the full set (`account_onboarding`, `account_management`,
 * `balances`, `payouts`, `payouts_list`, …) together. A read-only grant that
 * somehow mounted a bank-editing component would let a viewer-level co-manager
 * change bank details or initiate payouts through the embedded UI itself.
 */
import { describe, expect, it, vi } from "vitest";
import { createAccountSession, type EmbeddedComponent } from "@/lib/stripe-connect-embedded";

const KNOWN_COMPONENT_KEYS = [
  "account_onboarding",
  "account_management",
  "notification_banner",
  "balances",
  "payouts",
  "payouts_list",
  "payment_details",
  "documents",
] as const;

function fakeStripe(create: (params: unknown) => Promise<{ client_secret: string }>) {
  return { accountSessions: { create } } as unknown as Parameters<typeof createAccountSession>[0];
}

describe("createAccountSession — exactly one embedded component enabled", () => {
  it.each<EmbeddedComponent>(["account_onboarding", "account_management", "notification_banner"])(
    "enables ONLY %s, no other component key",
    async (component) => {
      const create = vi.fn(async (_params: { components: Record<string, unknown> }) => ({
        client_secret: "cs_test_123",
      }));
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_123";
      await createAccountSession(fakeStripe(create), "acct_1", component);

      expect(create).toHaveBeenCalledTimes(1);
      const params = create.mock.calls[0]![0] as { components: Record<string, unknown> };
      const enabledKeys = Object.keys(params.components);
      expect(enabledKeys).toEqual([component]);
      for (const other of KNOWN_COMPONENT_KEYS) {
        if (other === component) continue;
        expect(params.components).not.toHaveProperty(other);
      }
      expect(params.components[component]).toMatchObject({ enabled: true });
    },
  );

  it("read-only notification_banner mounts no bank-editing surface", async () => {
    const create = vi.fn(async () => ({ client_secret: "cs_test_456" }));
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_123";
    await createAccountSession(fakeStripe(create), "acct_1", "notification_banner");
    const params = create.mock.calls[0]![0] as { components: Record<string, unknown> };
    expect(params.components).not.toHaveProperty("account_management");
    expect(params.components).not.toHaveProperty("account_onboarding");
    expect(params.components).not.toHaveProperty("payouts");
  });
});
