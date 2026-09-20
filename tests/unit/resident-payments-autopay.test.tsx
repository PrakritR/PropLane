// @vitest-environment jsdom
//
// The resident Payments "Autopay" card, in isolation: renders on/off, the
// locked "Add a bank or card first" control with no saved method, the failed
// decline banner, and that turning it on/off calls PUT with the picked
// values. `GET /api/resident/autopay` and `PUT` are the only network calls —
// mocked directly rather than pulling in the whole (much heavier) payments
// panel this card is mounted inside.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ResidentAutopayCard } from "@/components/portal/resident-autopay-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockFetchOnce(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({ ok, json: async () => body });
}

function byAttr(container: HTMLElement, attr: string): HTMLElement {
  const el = container.querySelector(`[data-attr="${attr}"]`);
  if (!el) throw new Error(`No element with data-attr="${attr}"`);
  return el as HTMLElement;
}

const BASE_GET_RESPONSE = {
  managerAllowsAutopay: true,
  enabled: false,
  paymentMethodId: null,
  hasSavedMethod: true,
  savedMethods: [{ id: "pm_bank_1", type: "us_bank_account", label: "Chase •••• 4421", isDefault: true }],
  defaultMethod: { id: "pm_bank_1", type: "us_bank_account", label: "Chase •••• 4421", isDefault: true },
  runDaysBeforeDue: 0,
  nextScheduledCharge: null,
  failedRun: null,
};

describe("ResidentAutopayCard", () => {
  it("does not render when the manager has turned autopay off", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ ...BASE_GET_RESPONSE, managerAllowsAutopay: false }));
    render(<ResidentAutopayCard onManagePaymentMethods={() => {}} onPayChargeNow={() => {}} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("resident-autopay-card")).not.toBeInTheDocument();
  });

  it("renders Off with the toggle when there is a saved method", async () => {
    vi.stubGlobal("fetch", mockFetchOnce(BASE_GET_RESPONSE));
    const { container } = render(<ResidentAutopayCard onManagePaymentMethods={() => {}} onPayChargeNow={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("resident-autopay-card")).toBeInTheDocument());
    expect(byAttr(container, "resident-autopay-toggle")).toHaveTextContent("Off");
    expect(container.querySelector('[data-attr="resident-autopay-method"]')).not.toBeInTheDocument();
  });

  it("shows the locked control instead of the toggle when there is no saved method", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({ ...BASE_GET_RESPONSE, hasSavedMethod: false, savedMethods: [], defaultMethod: null }),
    );
    const onManage = vi.fn();
    const { container } = render(<ResidentAutopayCard onManagePaymentMethods={onManage} onPayChargeNow={() => {}} />);
    const addFirst = await screen.findByText("Add a bank or card first");
    expect(container.querySelector('[data-attr="resident-autopay-toggle"]')).not.toBeInTheDocument();
    fireEvent.click(addFirst);
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it("renders Pays with / Runs / Next payment when enabled, and calls PUT with the picked run-days value", async () => {
    const getResponse = {
      ...BASE_GET_RESPONSE,
      enabled: true,
      paymentMethodId: "pm_bank_1",
      runDaysBeforeDue: 0,
      nextScheduledCharge: "Oct 1 · $1,510.00",
    };
    const putResponse = { enabled: true, paymentMethodId: "pm_bank_1", runDaysBeforeDue: 3, nextScheduledCharge: "Sep 28 · $1,510.00" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => getResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => putResponse });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<ResidentAutopayCard onManagePaymentMethods={() => {}} onPayChargeNow={() => {}} />);
    await waitFor(() => expect(byAttr(container, "resident-autopay-next-charge")).toHaveTextContent("Oct 1 · $1,510.00"));
    expect(byAttr(container, "resident-autopay-method")).toBeInTheDocument();
    expect(byAttr(container, "resident-autopay-run-days")).toHaveTextContent("On the due date");

    await act(async () => {
      fireEvent.click(byAttr(container, "resident-autopay-run-days"));
    });
    const listbox = screen.getByRole("listbox");
    const option = within(listbox).getByText("3 days before");
    await act(async () => {
      fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const putCall = fetchMock.mock.calls[1];
    expect(putCall[0]).toBe("/api/resident/autopay");
    const putBody = JSON.parse(putCall[1].body as string);
    expect(putBody).toEqual({ enabled: true, paymentMethodId: "pm_bank_1", runDaysBeforeDue: 3 });

    await waitFor(() => expect(byAttr(container, "resident-autopay-next-charge")).toHaveTextContent("Sep 28 · $1,510.00"));
  });

  it("shows the decline banner with Pay now / Change method when the last run failed", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({
        ...BASE_GET_RESPONSE,
        enabled: true,
        paymentMethodId: "pm_bank_1",
        failedRun: { chargeId: "hc_1", chargeTitle: "October rent", failureReason: "Bank ·· 4421 was declined." },
      }),
    );
    const onPayNow = vi.fn();
    const onManage = vi.fn();
    const { container } = render(<ResidentAutopayCard onManagePaymentMethods={onManage} onPayChargeNow={onPayNow} />);

    await screen.findByTestId("resident-autopay-failed-banner");
    expect(screen.getByText("Autopay could not pay October rent")).toBeInTheDocument();
    expect(screen.getByText(/Bank ·· 4421 was declined\. Nothing was charged\./)).toBeInTheDocument();

    fireEvent.click(byAttr(container, "resident-autopay-pay-now"));
    expect(onPayNow).toHaveBeenCalledWith("hc_1");

    fireEvent.click(byAttr(container, "resident-autopay-change-method"));
    expect(onManage).toHaveBeenCalledTimes(1);
  });
});
