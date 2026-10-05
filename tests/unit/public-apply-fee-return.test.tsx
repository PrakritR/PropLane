// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const { wizard, loadProperty, getProperty, appUi } = vi.hoisted(() => ({
  wizard: vi.fn(() => { throw new Error("Checkout return mounted the draft wizard"); }),
  loadProperty: vi.fn(),
  getProperty: vi.fn(),
  appUi: vi.fn(() => ({ showToast: vi.fn() })),
}));
let searchParams = new URLSearchParams();
const router = { push: vi.fn(), replace: vi.fn() };

vi.mock("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => searchParams }));
vi.mock("@/components/marketing/rental-application-wizard", () => ({ RentalApplicationWizard: wizard }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: appUi }));
vi.mock("@/lib/rental-application/data", () => ({ getPropertyForPublicLink: getProperty }));
vi.mock("@/lib/demo-property-pipeline", () => ({ loadPublicPropertyLeadFromServer: loadProperty, PROPERTY_PIPELINE_EVENT: "test-properties" }));
vi.mock("@/lib/property-application-template-sync", () => ({ propertyAcceptingOnlineApplications: () => false }));
vi.mock("@/components/marketing/public-apply-account-prompt", () => ({ PublicApplyAccountPrompt: () => <div>Account required</div> }));
vi.mock("@/components/marketing/signed-in-resident-account-prompt", () => ({ SignedInResidentAccountPrompt: () => <div>Resident role required</div> }));

import { PublicApplyClient } from "@/app/(public)/rent/apply/public-apply-client";
import { ApplicationFeeReturnPanel } from "@/components/marketing/application-fee-return-panel";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function returnUrl(sessionId = "cs_return", kind = "return") {
  searchParams = new URLSearchParams({ propertyId: "unpublished-property", fee_checkout: kind, session_id: sessionId });
  window.history.replaceState(null, "", `/rent/apply?${searchParams}`);
}

function expectNoApplicationMount() {
  expect(wizard).not.toHaveBeenCalled();
  expect(loadProperty).not.toHaveBeenCalled();
  expect(getProperty).not.toHaveBeenCalled();
  expect(appUi).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  loadProperty.mockResolvedValue(undefined);
  getProperty.mockReturnValue({ id: "unpublished-property", title: "Closed listing", listingSubmission: {} });
  returnUrl();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("public apply Checkout return bypasses only the account and listing gates", () => {
  it.each(["return", "success"])("verifies a signed-out %s before unpublished-listing and account gates", async (kind) => {
    returnUrl(" cs_return ", kind);
    const fetchMock = vi.fn().mockResolvedValue(response({ paid: true, applicationPromoted: true,
      applicationAxisId: "PROPLANE-RETURN", applicationSetupEmailSent: true,
      email: "private@example.com", applicationSetupToken: "must-not-display", mailtoHref: "mailto:private@example.com" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<PublicApplyClient />);

    expect(await screen.findByRole("heading", { name: "Application submitted" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ sessionId: "cs_return" });
    expect(screen.queryByText("Account required")).toBeNull();
    expect(screen.queryByRole("link", { name: "Create your resident account" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open setup email draft" })).toBeNull();
    expect(document.body.textContent).not.toContain("private@example.com");
    expect(document.body.innerHTML).not.toContain("must-not-display");
    expectNoApplicationMount();
    expect(window.location.search).toContain("session_id=");
  });

  it("uses the safe email failure finish state when the server reports delivery failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ paid: true, applicationPromoted: true,
      applicationAxisId: "PROPLANE-RETURN", applicationSetupEmailSent: false })));
    render(<PublicApplyClient signedInNonResident />);
    expect(await screen.findByRole("heading", { name: "Application submitted" })).toBeTruthy();
    expect(screen.getByText(/Ask your property manager to resend it/)).toBeTruthy();
    expectNoApplicationMount();
  });

  it.each([
    [undefined, "cs_return"],
    ["cancel", "cs_return"],
    ["return", ""],
    ["success", "   "],
    ["unrecognized", "cs_return"],
  ])("keeps the normal account gate for checkout=%s and session=%s", async (checkout, sessionId) => {
    searchParams = new URLSearchParams({ propertyId: "unpublished-property", session_id: sessionId });
    if (checkout) searchParams.set("fee_checkout", checkout);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => { render(<PublicApplyClient />); });
    expect(screen.getByText("Account required")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wizard).not.toHaveBeenCalled();
  });
});

describe("dedicated verification recovery", () => {
  it("exposes retry when an otherwise silent network request times out", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("request aborted")));
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicApplyClient />);
    expect(screen.getByRole("status")).toHaveTextContent("Verifying payment");
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByRole("button", { name: "Retry verification" })).toBeTruthy();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expectNoApplicationMount();
  });

  it("leaves paid unpromoted reporting to verification without an invalid client report", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => response({ paid: true, applicationPromoted: false }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicApplyClient />);
    expect(await screen.findByRole("alert")).toHaveTextContent("saved application could not be submitted");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/stripe/application-fee-verify");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ sessionId: "cs_return" });
    expectNoApplicationMount();
  });

  it.each([
    [{ paid: false }, 200, "Could not confirm payment"],
    [{ paid: false, processing: true }, 200, "bank transfer is still processing"],
    [{ paid: false, processing: true, processingReason: "recipient_routing" }, 202,
      "Payment was captured. Manager payout routing is still processing"],
    [{ paid: true, applicationPromoted: false }, 200, "saved application could not be submitted"],
    [{ paid: true, applicationPromoted: true, applicationAxisId: "  " }, 200, "saved application could not be submitted"],
    [{ error: "Session not found." }, 404, "Session not found"],
  ])("keeps a visible retry for an unsuccessful verification %#", async (body, status, message) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response(body, status)));
    render(<PublicApplyClient />);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Retry verification" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Application submitted" })).toBeNull();
    expectNoApplicationMount();
    expect(window.location.search).toContain("session_id=cs_return");
  });

  it("retries after network rejection and sends no partial form or recipient identity", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(response({ paid: true, applicationPromoted: true, applicationAxisId: "PROPLANE-RETURN", applicationSetupEmailSent: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicApplyClient />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Check your connection");
    fireEvent.click(screen.getByRole("button", { name: "Retry verification" }));
    expect(await screen.findByRole("heading", { name: "Application submitted" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) expect(JSON.parse(init.body)).toEqual({ sessionId: "cs_return" });
    expectNoApplicationMount();
  });

  it("retries a captured card's delayed destination routing with the same session", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ paid: false, processing: true,
        processingReason: "recipient_routing" }, 202))
      .mockResolvedValueOnce(response({ paid: true, applicationPromoted: true,
        applicationAxisId: "PROPLANE-ROUTED", applicationSetupEmailSent: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicApplyClient />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Payment was captured");
    fireEvent.click(screen.getByRole("button", { name: "Retry verification" }));
    expect(await screen.findByRole("heading", { name: "Application submitted" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(init.body)).toEqual({ sessionId: "cs_return" });
    }
    expectNoApplicationMount();
  });

  it("ignores an old success while a different Checkout session is being verified", async () => {
    let resolveOld!: (result: Response) => void;
    let resolveNew!: (result: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveNew = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<ApplicationFeeReturnPanel sessionId="cs_old" />);
    view.rerender(<ApplicationFeeReturnPanel sessionId="cs_new" />);
    await act(async () => { resolveOld(response({ paid: true, applicationPromoted: true, applicationAxisId: "PROPLANE-OLD" })); });
    expect(screen.queryByRole("heading", { name: "Application submitted" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Verifying payment");
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { resolveNew(response({ paid: true, applicationPromoted: true, applicationAxisId: "PROPLANE-NEW", applicationSetupEmailSent: true })); });
    expect(screen.getByText("Application ID: PROPLANE-NEW")).toBeTruthy();
    expect(document.body.textContent).not.toContain("PROPLANE-OLD");
  });

  it("aborts and ignores an outstanding request when unmounted", async () => {
    let resolveRequest!: (result: Response) => void;
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { resolveRequest = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<ApplicationFeeReturnPanel sessionId="cs_unmount" />);
    view.unmount();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { resolveRequest(response({ paid: true, applicationPromoted: true, applicationAxisId: "PROPLANE-OLD" })); });
    expect(screen.queryByRole("heading", { name: "Application submitted" })).toBeNull();
  });
});
