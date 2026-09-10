// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
const native = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/use-is-native-app", () => ({
  useIsNativeApp: () => ({ isNative: native.value }),
}));
vi.mock("@/components/stripe/embedded-checkout", () => ({
  EmbeddedCheckoutMount: () => <div>Stripe secure setup</div>,
}));
import { ManagerPaymentMethodsPanel } from "@/components/portal/manager-payment-methods-panel";
const card = {
  id: "pm_saved",
  brand: "visa",
  last4: "4242",
  expMonth: 12,
  expYear: 2030,
  isDefault: false,
};
beforeEach(() => {
  native.value = false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("saved cards in Billing & plan", () => {
  it("adds a card through setup without purchasing credit", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
      Response.json(
        init?.method === "POST"
          ? { clientSecret: "secret_test" }
          : { cards: [] },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    render(<ManagerPaymentMethodsPanel />);
    await screen.findByText(/No cards saved yet/);
    fireEvent.click(screen.getByRole("button", { name: "Add card" }));
    await screen.findByText("Stripe secure setup");
    expect(
      fetcher.mock.calls.every(
        ([url]) => url === "/api/manager/payment-methods",
      ),
    ).toBe(true);
    const post = fetcher.mock.calls.find(
      ([, init]) => init?.method === "POST",
    )?.[1];
    expect(Object.keys(JSON.parse(String(post?.body)))).toEqual([
      "operationId",
    ]);
  });
  it("reflects the server-confirmed default", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
      Response.json({
        cards: [{ ...card, isDefault: init?.method === "PATCH" }],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    render(<ManagerPaymentMethodsPanel />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Set as default" }),
    );
    await screen.findByText("Default card updated.");
    expect(screen.getByText("Default")).toBeTruthy();
    expect(
      fetcher.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1]
        ?.body,
    ).toBe(JSON.stringify({ paymentMethodId: "pm_saved" }));
  });
  it("allows only one default-card change at a time", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetcher = vi.fn((_url: unknown, init?: RequestInit) =>
      init?.method === "PATCH"
        ? pending
        : Promise.resolve(
            Response.json({
              cards: [card, { ...card, id: "pm_second", last4: "4444" }],
            }),
          ),
    );
    vi.stubGlobal("fetch", fetcher);
    render(<ManagerPaymentMethodsPanel />);
    const buttons = await screen.findAllByRole("button", {
      name: "Set as default",
    });
    fireEvent.click(buttons[0]);
    expect(buttons[1].hasAttribute("disabled")).toBe(true);
    fireEvent.click(buttons[1]);
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH"),
    ).toHaveLength(1);
    finish(Response.json({ cards: [{ ...card, isDefault: true }] }));
    await screen.findByText("Default card updated.");
  });
  it("shows a retryable loading failure without offering card setup", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ error: "Billing unavailable" }, { status: 503 }),
        )
        .mockResolvedValue(Response.json({ cards: [card] })),
    );
    render(<ManagerPaymentMethodsPanel />);
    await screen.findByRole("alert");
    expect(
      screen.getByRole("button", { name: "Add card" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: "Set as default" });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
  it("keeps external card setup and default controls out of native billing", async () => {
    native.value = true;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ cards: [card] })),
    );
    render(<ManagerPaymentMethodsPanel />);
    await screen.findByText(/Expires/);
    expect(screen.queryByRole("button", { name: "Add card" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set as default" })).toBeNull();
  });
});
