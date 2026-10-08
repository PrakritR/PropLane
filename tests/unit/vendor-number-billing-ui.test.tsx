// @vitest-environment jsdom
// Vendor Settings > Work number & email with the PropLane Number subscription: not subscribed ("Your own work
// number $5 / month Subscribe"), subscribed (plan line + Manage, Credit + Buy credit), out of credit, paused.
// With the subscription off the page is exactly the free claim it always was.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { VendorWorkNumberSettings } from "@/components/portal/vendor-work-number-settings";

const base = {
  sponsoredBy: "proplane",
  email: { state: "ready", value: "vendor-abc@vendors.proplane.ai", sendReady: true, receiveReady: true, canSetup: false, blockedReason: "none" },
  inboundAvailable: { email: true, sms: false },
  smsUiEnabled: true,
  usage: { outboundUsed: 0, outboundCap: 1000, capState: "available", smsSegmentsUsed: 0 },
  eligibility: { phoneVerified: true, verifiedPhoneLabel: "(206) 555-0142" },
  forwardToPhone: true,
};
const noNumber = { ...base, sms: { state: "not_started", value: null, sendReady: false, receiveReady: false, canSetup: true, blockedReason: "none" } };
const noNumberLocked = { ...base, sms: { state: "not_started", value: null, sendReady: false, receiveReady: false, canSetup: false, blockedReason: "subscription_required" } };
const withNumber = { ...base, sms: { state: "ready", value: "+12065550142", sendReady: true, receiveReady: true, canSetup: false, blockedReason: "none" } };
const pausedNumber = { ...base, sms: { state: "ready", value: "+12065550142", sendReady: false, receiveReady: true, canSetup: false, blockedReason: "subscription_required" } };

type Billing = {
  enabled: boolean;
  subscription: { status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  credit: { includedCents: number; purchasedCents: number; totalCents: number } | null;
};
const off: Billing = { enabled: false, subscription: null, credit: null };
const unsubscribed: Billing = { enabled: true, subscription: null, credit: { includedCents: 0, purchasedCents: 0, totalCents: 0 } };
const subscribed: Billing = {
  enabled: true,
  subscription: { status: "active", currentPeriodEnd: "2026-11-08T12:00:00Z", cancelAtPeriodEnd: false },
  credit: { includedCents: 241, purchasedCents: 1000, totalCents: 1241 },
};

function mockFetch(identity: unknown, billing: Billing, onPost?: (url: string, body: Record<string, unknown>) => unknown) {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url.startsWith("/api/number-subscription") && (init?.method ?? "GET") === "GET") {
        return { ok: true, json: async () => ({ ok: true, priceCents: 500, ...billing }) };
      }
      if (url.startsWith("/api/number-subscription")) {
        return { ok: true, json: async () => onPost?.(url, body ?? {}) ?? { ok: true, url: "https://checkout.stripe.test/s" } };
      }
      return { ok: true, json: async () => ({ ok: true, identity }) };
    }),
  );
  return calls;
}

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  window.history.pushState({}, "", "/vendor/settings?tab=work-number-email");
  assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { pathname: "/vendor/settings", search: "?tab=work-number-email", assign },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("subscription off", () => {
  it("is the free claim: no Subscribe, no billing rows", async () => {
    mockFetch(noNumber, off);
    const { findByText, queryByText } = render(<VendorWorkNumberSettings />);
    expect(await findByText("Find numbers")).toBeTruthy();
    expect(queryByText("Subscribe")).toBeNull();
    expect(queryByText("Your own work number")).toBeNull();
  });
});

describe("not subscribed", () => {
  it("shows 'Your own work number', '$5 / month' and Subscribe instead of the claim", async () => {
    mockFetch(noNumberLocked, unsubscribed);
    const { findByText, queryByText } = render(<VendorWorkNumberSettings />);
    expect(await findByText("Your own work number")).toBeTruthy();
    expect(await findByText("$5 / month")).toBeTruthy();
    expect(await findByText("Subscribe")).toBeTruthy();
    expect(queryByText("Find numbers")).toBeNull();
    expect(queryByText("Buy credit")).toBeNull();
  });

  it("Subscribe starts Checkout for the vendor role and returns to this page", async () => {
    const calls = mockFetch(noNumberLocked, unsubscribed);
    const { findByText } = render(<VendorWorkNumberSettings />);
    fireEvent.click(await findByText("Subscribe"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.stripe.test/s"));
    const post = calls.find((c) => c.url === "/api/number-subscription/checkout");
    expect(post?.method).toBe("POST");
    expect(post?.body).toEqual({ role: "vendor", returnPath: "/vendor/settings?tab=work-number-email" });
  });

  it("a refused checkout says so and goes nowhere", async () => {
    mockFetch(noNumberLocked, unsubscribed, () => ({ ok: false, error: "Checkout is temporarily unavailable." }));
    const { findByText } = render(<VendorWorkNumberSettings />);
    fireEvent.click(await findByText("Subscribe"));
    expect(await findByText("Checkout is temporarily unavailable.")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it("a lapsed vendor's held number is shown paused next to Subscribe", async () => {
    mockFetch(pausedNumber, { ...unsubscribed, subscription: { status: "canceled", currentPeriodEnd: null, cancelAtPeriodEnd: false } });
    const { findByText } = render(<VendorWorkNumberSettings />);
    expect(await findByText("+1 (206) 555-0142")).toBeTruthy();
    expect(await findByText("Paused")).toBeTruthy();
    expect(await findByText("Subscribe")).toBeTruthy();
  });
});

describe("subscribed", () => {
  it("shows the number, the plan line with the renewal date, and the credit row", async () => {
    mockFetch(withNumber, subscribed);
    const { findByText, queryByText } = render(<VendorWorkNumberSettings />);
    expect(await findByText("+1 (206) 555-0142")).toBeTruthy();
    expect(await findByText("PropLane Number · $5/month · renews Nov 8")).toBeTruthy();
    expect(await findByText("$2.41 left this month · $10.00 bought")).toBeTruthy();
    expect(await findByText("Buy credit")).toBeTruthy();
    expect(queryByText("Subscribe")).toBeNull();
  });

  it("a subscription set to end says when", async () => {
    mockFetch(withNumber, { ...subscribed, subscription: { ...subscribed.subscription!, cancelAtPeriodEnd: true } });
    const { findByText } = render(<VendorWorkNumberSettings />);
    expect(await findByText("PropLane Number · $5/month · ends Nov 8")).toBeTruthy();
  });

  it("a failed payment is said plainly", async () => {
    mockFetch(withNumber, { ...subscribed, subscription: { ...subscribed.subscription!, status: "past_due" } });
    const { findByText } = render(<VendorWorkNumberSettings />);
    expect(await findByText("PropLane Number · $5/month · payment failed")).toBeTruthy();
  });

  it("Manage opens the billing portal", async () => {
    const calls = mockFetch(withNumber, subscribed);
    const { findByLabelText } = render(<VendorWorkNumberSettings />);
    fireEvent.click(await findByLabelText("Manage subscription"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.stripe.test/s"));
    expect(calls.find((c) => c.url === "/api/number-subscription/portal")?.body).toMatchObject({ role: "vendor" });
  });

  it("subscribed with no number yet still offers the claim", async () => {
    mockFetch(noNumber, subscribed);
    const { findByText } = render(<VendorWorkNumberSettings />);
    expect(await findByText("Find numbers")).toBeTruthy();
    expect(await findByText("PropLane Number · $5/month · renews Nov 8")).toBeTruthy();
  });
});

describe("buy credit", () => {
  it("pays a whole-dollar amount through credit-checkout with a purchase id", async () => {
    const calls = mockFetch(withNumber, subscribed);
    const { findByText, findByLabelText } = render(<VendorWorkNumberSettings />);
    fireEvent.click(await findByText("Buy credit"));
    const amount = await findByLabelText("Credit amount in dollars");
    fireEvent.change(amount, { target: { value: "25" } });
    fireEvent.click(await findByText("Pay $25"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.stripe.test/s"));
    const post = calls.find((c) => c.url === "/api/number-subscription/credit-checkout");
    expect(post?.body).toMatchObject({ role: "vendor", creditCents: 2500 });
    expect(String(post?.body?.purchaseId)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("refuses amounts outside $5 to $500 before any request", async () => {
    const calls = mockFetch(withNumber, subscribed);
    const { findByText, findByLabelText, getByText } = render(<VendorWorkNumberSettings />);
    fireEvent.click(await findByText("Buy credit"));
    const amount = await findByLabelText("Credit amount in dollars");
    for (const bad of ["3", "501", ""]) {
      fireEvent.change(amount, { target: { value: bad } });
      expect((getByText(/^Pay/).closest("button") as HTMLButtonElement).disabled).toBe(true);
    }
    expect(calls.some((c) => c.url.includes("credit-checkout"))).toBe(false);
  });
});

describe("out of credit", () => {
  it("says Out of credit, that texts and AI replies are paused, and offers Buy credit", async () => {
    mockFetch(withNumber, { ...subscribed, credit: { includedCents: 0, purchasedCents: 0, totalCents: 0 } });
    const { findByText } = render(<VendorWorkNumberSettings />);
    expect(await findByText("Out of credit")).toBeTruthy();
    expect(await findByText("AI replies and texts are paused until the 1st or until you buy credit")).toBeTruthy();
    expect(await findByText("Buy credit")).toBeTruthy();
  });
});
