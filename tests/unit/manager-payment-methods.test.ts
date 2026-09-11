import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  purchase: vi.fn(),
  auth: vi.fn(),
  customer: vi.fn(),
  createCustomer: vi.fn(),
  saveCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  methods: vi.fn(),
  method: vi.fn(),
  subscription: vi.fn(),
  updateSubscription: vi.fn(),
  setup: vi.fn(),
}));
vi.mock("@/lib/manager-route-guard.server", () => ({
  requireManagerRouteUser: mocks.auth,
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    customers: {
      retrieve: mocks.customer,
      create: mocks.createCustomer,
      update: mocks.updateCustomer,
    },
    paymentMethods: { list: mocks.methods, retrieve: mocks.method },
    subscriptions: {
      retrieve: mocks.subscription,
      update: mocks.updateSubscription,
    },
    checkout: { sessions: { create: mocks.setup } },
  }),
}));
import { GET, POST, PATCH } from "@/app/api/manager/payment-methods/route";
import {
  listManagerBillingCards,
  setManagerDefaultBillingCard,
} from "@/lib/manager-stripe-customer.server";
const database = () => ({
  from: (table: string) => {
    const query = {
      select: () => query,
      eq: vi.fn(() => query),
      or: () => query,
      order: () => query,
      limit: async () => mocks.purchase(),
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({
        data: { email: "manager@example.test", full_name: "Test Manager" },
        error: null,
      }),
      upsert: mocks.saveCustomer,
    };
    if (
      table !== "manager_purchases" &&
      table !== "manager_comms_billing_accounts" &&
      table !== "profiles"
    )
      throw new Error("unexpected table");
    return query;
  },
});
const req = (body: unknown) =>
  new Request("http://localhost/api/manager/payment-methods", {
    method: "POST",
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.createCustomer.mockResolvedValue({ id: "cus_created" });
  mocks.saveCustomer.mockResolvedValue({ error: null });
  mocks.auth.mockResolvedValue({ userId: "owner", db: database() });
  mocks.purchase.mockResolvedValue({
    data: [
      {
        user_id: "owner",
        stripe_customer_id: "cus_owner",
        stripe_subscription_id: "sub_owner",
      },
    ],
    error: null,
  });
  mocks.customer.mockResolvedValue({
    id: "cus_owner",
    metadata: { manager_user_id: "owner" },
    invoice_settings: { default_payment_method: "pm_old" },
  });
  mocks.methods.mockResolvedValue({
    data: [
      {
        id: "pm_new",
        type: "card",
        card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
      },
    ],
  });
  mocks.method.mockResolvedValue({
    id: "pm_new",
    type: "card",
    customer: "cus_owner",
    card: { exp_month: 12, exp_year: 2030 },
  });
  mocks.subscription.mockResolvedValue({
    id: "sub_owner",
    customer: "cus_owner",
    status: "active",
    default_payment_method: "pm_old",
  });
  mocks.setup.mockResolvedValue({ client_secret: "secret_test" });
});
describe("manager saved card ownership", () => {
  it("never creates a Stripe customer during an empty GET", async () => {
    mocks.purchase.mockResolvedValue({ data: [], error: null });
    expect(await listManagerBillingCards(database() as never, "owner")).toEqual(
      { cards: [], defaultPaymentMethodId: null },
    );
    expect(mocks.createCustomer).not.toHaveBeenCalled();
  });
  it("creates an owner-linked billing customer on explicit first-time card setup", async () => {
    mocks.purchase.mockResolvedValue({ data: [], error: null });
    const response = await POST(
      req({ operationId: "12345678-1234-4123-8123-123456789abc" }),
    );
    expect(response.status).toBe(200);
    expect(mocks.createCustomer).toHaveBeenCalledWith(
      {
        email: "manager@example.test",
        name: "Test Manager",
        metadata: { manager_user_id: "owner", purpose: "manager_billing" },
      },
      { idempotencyKey: "manager-billing-customer:owner" },
    );
    expect(mocks.saveCustomer).toHaveBeenCalledWith(
      { manager_user_id: "owner", stripe_customer_id: "cus_created" },
      { onConflict: "manager_user_id" },
    );
    expect(mocks.setup).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "setup", customer: "cus_created" }),
      expect.anything(),
    );
  });
  it("does not open setup if the new customer identity could not be persisted", async () => {
    mocks.purchase.mockResolvedValue({ data: [], error: null });
    mocks.saveCustomer.mockResolvedValue({
      error: { message: "database unavailable" },
    });
    expect(
      (await POST(req({ operationId: "12345678-1234-4123-8123-123456789abc" })))
        .status,
    ).toBe(503);
    expect(mocks.setup).not.toHaveBeenCalled();
  });
  it("stops on an unknown billing identity", async () => {
    mocks.purchase.mockResolvedValue({
      data: null,
      error: { message: "offline" },
    });
    expect((await GET()).status).toBe(503);
    expect(mocks.methods).not.toHaveBeenCalled();
  });
  it("does not authorize an email-matched purchase owned by someone else", async () => {
    mocks.purchase.mockResolvedValue({
      data: [
        {
          user_id: "other",
          stripe_customer_id: "cus_other",
          stripe_subscription_id: "sub_other",
        },
      ],
      error: null,
    });
    expect(await listManagerBillingCards(database() as never, "owner")).toEqual(
      { cards: [], defaultPaymentMethodId: null },
    );
    expect(mocks.customer).not.toHaveBeenCalled();
    expect(mocks.subscription).not.toHaveBeenCalled();
  });
  it("cannot choose another customer's card", async () => {
    mocks.method.mockResolvedValue({
      id: "pm_stolen",
      type: "card",
      customer: "cus_other",
    });
    await expect(
      setManagerDefaultBillingCard(database() as never, "owner", "pm_stolen"),
    ).rejects.toThrow("saved to your billing account");
    expect(mocks.updateCustomer).not.toHaveBeenCalled();
    expect(mocks.updateSubscription).not.toHaveBeenCalled();
  });
  it("verifies subscription ownership before changing either default", async () => {
    mocks.subscription.mockResolvedValue({ customer: "cus_other" });
    await expect(
      setManagerDefaultBillingCard(database() as never, "owner", "pm_new"),
    ).rejects.toThrow("identity");
    expect(mocks.updateCustomer).not.toHaveBeenCalled();
  });
  it("updates customer and subscription defaults without charging", async () => {
    await setManagerDefaultBillingCard(database() as never, "owner", "pm_new");
    expect(mocks.updateCustomer).toHaveBeenCalledWith("cus_owner", {
      invoice_settings: { default_payment_method: "pm_new" },
    });
    expect(mocks.updateSubscription).toHaveBeenCalledWith("sub_owner", {
      default_payment_method: "pm_new",
    });
    expect(mocks.setup).not.toHaveBeenCalled();
  });
  it("reads the subscription once per operation and re-reads it after the default changes", async () => {
    await listManagerBillingCards(database() as never, "owner");
    expect(mocks.subscription).toHaveBeenCalledTimes(1);
    expect(mocks.customer).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocks.subscription
      .mockResolvedValueOnce({
        id: "sub_owner",
        customer: "cus_owner",
        status: "active",
        default_payment_method: "pm_old",
      })
      .mockResolvedValueOnce({
        id: "sub_owner",
        customer: "cus_owner",
        status: "active",
        default_payment_method: "pm_new",
      });
    const result = await setManagerDefaultBillingCard(
      database() as never,
      "owner",
      "pm_new",
    );
    expect(mocks.subscription).toHaveBeenCalledTimes(2);
    expect(mocks.customer).toHaveBeenCalledTimes(2);
    expect(mocks.updateSubscription).toHaveBeenCalledTimes(1);
    expect(result.defaultPaymentMethodId).toBe("pm_new");
    expect(result.cards[0]).toMatchObject({ id: "pm_new", isDefault: true });
  });
  it("updates only the customer after a subscription is canceled", async () => {
    mocks.subscription.mockResolvedValue({
      id: "sub_owner",
      customer: "cus_owner",
      status: "canceled",
      default_payment_method: "pm_old",
    });
    await setManagerDefaultBillingCard(database() as never, "owner", "pm_new");
    expect(mocks.updateCustomer).toHaveBeenCalled();
    expect(mocks.updateSubscription).not.toHaveBeenCalled();
  });
  it("resolves a linked subscription customer when the purchase lacks one", async () => {
    mocks.purchase.mockResolvedValue({
      data: [
        {
          user_id: "owner",
          stripe_customer_id: null,
          stripe_subscription_id: "sub_owner",
        },
      ],
      error: null,
    });
    await listManagerBillingCards(database() as never, "owner");
    expect(mocks.methods).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_owner" }),
    );
  });
  it("requires manager authentication on every endpoint", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await POST(req({}))).status).toBe(401);
    expect((await PATCH(req({}))).status).toBe(401);
  });
  it("opens Stripe setup with no payment and a fixed Billing & plan return", async () => {
    const response = await POST(
      req({ operationId: "12345678-1234-4123-8123-123456789abc" }),
    );
    expect(response.status).toBe(200);
    expect(mocks.setup).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "setup",
        customer: "cus_owner",
        client_reference_id: "owner",
        payment_method_types: ["card"],
        return_url: expect.stringContaining(
          "/portal/profile?tab=billing&card_setup=",
        ),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("owner"),
      }),
    );
    expect(mocks.updateCustomer).not.toHaveBeenCalled();
  });
  it("rejects an injected customer or return URL", async () => {
    expect(
      (
        await POST(
          req({
            operationId: "12345678-1234-4123-8123-123456789abc",
            customerId: "cus_other",
            returnUrl: "https://other.test",
          }),
        )
      ).status,
    ).toBe(400);
    expect(mocks.setup).not.toHaveBeenCalled();
  });
});
