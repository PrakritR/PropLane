// @vitest-environment jsdom
//
// Pre-apply gate (UI): the form opens only once every step the property's manager requires is satisfied, one clear step
// list with a status per step, and resuming lands on the next step.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ demo: false }));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => h.demo,
}));
vi.mock("@/components/stripe-embedded-checkout", () => ({
  StripeEmbeddedCheckout: () => <div data-testid="stripe-embedded-checkout" />,
}));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { ResidentPreApplyGate } from "@/components/portal/resident-preapply-gate";
import type { PreApplyApiView } from "@/lib/screening/preapply-view";

const disclosure = { version: "v1", text: "Disclosure text", authorizationLabel: "I authorize the report" };
const quote = { packageSlug: "starter", packageName: "Starter", packageCents: 2499, addOnProducts: ["identity_verification"], idCheckCents: 295, totalCents: 2794 } as const;

function view(over: Partial<PreApplyApiView> = {}): PreApplyApiView {
  return {
    required: true,
    satisfied: false,
    provider: "checkr",
    quote: quote as unknown as PreApplyApiView["quote"],
    orderAllowed: true,
    next: "verify_id",
    steps: [
      { id: "verify_id", label: "Verify ID", status: "todo", satisfied: false },
      { id: "background_check", label: "Background check", status: "todo", satisfied: false },
    ],
    disclosure,
    ...over,
  };
}

function mockFetch(handlers: (url: string, init?: RequestInit) => unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const out = handlers(url, init) as { status?: number; body: unknown };
      return { ok: (out.status ?? 200) < 400, status: out.status ?? 200, json: async () => out.body } as Response;
    }),
  );
  return calls;
}

const form = <div data-testid="application-form">The application form</div>;

beforeEach(() => {
  h.demo = false;
  window.history.replaceState({}, "", "/resident/applications/apply?propertyId=prop-1");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ResidentPreApplyGate", () => {
  it("keeps the form shut and shows Verify ID → Background check → Application, with the exact total, until authorized", async () => {
    mockFetch(() => ({ body: view() }));
    render(<ResidentPreApplyGate propertyId="prop-1">{form}</ResidentPreApplyGate>);
    await waitFor(() => expect(document.querySelector('[data-attr="preapply-gate"]')).not.toBeNull());
    expect(screen.queryByTestId("application-form")).toBeNull();
    const labels = Array.from(document.querySelectorAll('[data-attr^="preapply-step-"]')).map((el) => el.textContent ?? "");
    expect(labels[0]).toContain("Verify ID");
    expect(labels[1]).toContain("Background check");
    expect(labels[2]).toContain("Application");
    expect(document.querySelector('[data-attr="preapply-summary"]')?.textContent).toContain("$27.94");
    const pay = document.querySelector('[data-attr="preapply-pay"]') as HTMLButtonElement;
    expect(pay.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(disclosure.authorizationLabel));
    expect(pay.disabled).toBe(false);
  });

  it("opens the Stripe form after authorization, sending the disclosure version and the return path (never an amount)", async () => {
    const calls = mockFetch((url) =>
      url.startsWith("/api/screening/preapply/checkout") ? { body: { ok: true, clientSecret: "secret_1" } } : { body: view() },
    );
    render(<ResidentPreApplyGate propertyId="prop-1">{form}</ResidentPreApplyGate>);
    await waitFor(() => expect(document.querySelector('[data-attr="preapply-pay"]')).not.toBeNull());
    fireEvent.click(screen.getByLabelText(disclosure.authorizationLabel));
    fireEvent.click(document.querySelector('[data-attr="preapply-pay"]') as HTMLButtonElement);
    await screen.findByTestId("stripe-embedded-checkout");
    const checkout = calls.find((c) => c.url === "/api/screening/preapply/checkout")!;
    const body = JSON.parse(String(checkout.init?.body));
    expect(body).toMatchObject({ propertyId: "prop-1", authorize: true, disclosureVersion: "v1", returnPath: "/resident/applications/apply?propertyId=prop-1" });
    expect(body.amount).toBeUndefined();
    expect(body.totalCents).toBeUndefined();
  });

  it("resuming lands on the next step: a placed order waiting on the ID shows progress, not the payment form", async () => {
    mockFetch(() => ({
      body: view({
        quote: null,
        orderAllowed: false,
        steps: [
          { id: "verify_id", label: "Verify ID", status: "in_progress", satisfied: false },
          { id: "background_check", label: "Background check", status: "in_progress", satisfied: true },
        ],
      }),
    }));
    render(<ResidentPreApplyGate propertyId="prop-1">{form}</ResidentPreApplyGate>);
    await waitFor(() => expect(document.querySelector('[data-attr="preapply-waiting"]')).not.toBeNull());
    expect(document.querySelector('[data-attr="preapply-pay"]')).toBeNull();
    expect(screen.queryByTestId("application-form")).toBeNull();
  });

  it("opens the form once every required step is satisfied", async () => {
    mockFetch(() => ({ body: view({ satisfied: true, next: "application" }) }));
    render(<ResidentPreApplyGate propertyId="prop-1">{form}</ResidentPreApplyGate>);
    await screen.findByTestId("application-form");
  });

  it("a listing that requires nothing shows the form unchanged", async () => {
    mockFetch(() => ({ body: view({ required: false, satisfied: true, steps: [], next: "application" }) }));
    render(<ResidentPreApplyGate propertyId="prop-1">{form}</ResidentPreApplyGate>);
    await screen.findByTestId("application-form");
  });

  it("Persona: Verify ID is a link to the standalone flow, not a payment", async () => {
    mockFetch(() => ({
      body: view({
        provider: "persona",
        quote: null,
        steps: [{ id: "verify_id", label: "Verify ID", status: "todo", satisfied: false }],
      }),
    }));
    render(<ResidentPreApplyGate propertyId="prop-1">{form}</ResidentPreApplyGate>);
    await waitFor(() => expect(document.querySelector('a[href="/resident/profile?tab=profile#verification"]')).not.toBeNull());
    expect(document.querySelector('[data-attr="preapply-pay"]')).toBeNull();
  });

  it("an unavailable or unreviewed ID is a plain fact and the form stays shut", async () => {
    mockFetch(() => ({
      body: view({ quote: null, steps: [{ id: "verify_id", label: "Verify ID", status: "blocked", satisfied: false, reason: "unavailable" }] }),
    }));
    render(<ResidentPreApplyGate propertyId="prop-1">{form}</ResidentPreApplyGate>);
    await waitFor(() => expect(document.querySelector('[data-attr="preapply-blocked"]')?.textContent).toContain("ID check unavailable"));
    expect(screen.queryByTestId("application-form")).toBeNull();
  });

  it("does nothing for /demo or a missing property; the server still enforces the submit", async () => {
    const calls = mockFetch(() => ({ body: view() }));
    h.demo = true;
    const { unmount } = render(<ResidentPreApplyGate propertyId="prop-1">{form}</ResidentPreApplyGate>);
    expect(screen.getByTestId("application-form")).toBeTruthy();
    unmount();
    h.demo = false;
    render(<ResidentPreApplyGate propertyId={undefined}>{form}</ResidentPreApplyGate>);
    expect(screen.getByTestId("application-form")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("a signed-out or unresolvable listing (401/403/404) falls through to the form", async () => {
    mockFetch(() => ({ status: 403, body: { error: "Forbidden." } }));
    render(<ResidentPreApplyGate propertyId="prop-1">{form}</ResidentPreApplyGate>);
    await screen.findByTestId("application-form");
  });

  it("a server error shows a retry, never an open form", async () => {
    mockFetch(() => ({ status: 503, body: { error: "down" } }));
    render(<ResidentPreApplyGate propertyId="prop-1">{form}</ResidentPreApplyGate>);
    await waitFor(() => expect(document.querySelector('[data-attr="preapply-unavailable"]')).not.toBeNull());
    expect(screen.queryByTestId("application-form")).toBeNull();
  });
});
