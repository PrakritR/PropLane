// @vitest-environment jsdom
//
// "Application before a tour", the page half: the public Schedule tour door sends a visitor to
// apply when the workspace asks for it, and the tour flow shows an Apply panel (not the slot
// picker) until the server says this account has applied.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/hooks/use-prospect-contact-autofill", () => ({
  useProspectContactAutofill: () => ({ ready: true, userId: null, hasResidentRole: false, name: "", email: "", phone: "" }),
}));

import { buildProspectTourHref } from "@/lib/prospect-public-nav";
import { TourApplicationFirstPanel } from "@/components/marketing/tour-application-first-panel";
import { useTourApplicationGate } from "@/hooks/use-tour-application-gate";

const anon = { ready: true, userId: null, hasResidentRole: false };
const resident = { ready: true, userId: "u1", hasResidentRole: true };

describe("buildProspectTourHref", () => {
  it("is the tour contact page by default", () => {
    expect(buildProspectTourHref("prop-1", anon)).toContain("/rent/tours-contact");
  });

  it("sends a visitor to apply first when the workspace requires it", () => {
    const href = buildProspectTourHref("prop-1", anon, { applicationFirst: true });
    expect(href).not.toContain("tours-contact");
    expect(href).toContain("prop-1");
  });

  it("keeps a signed-in resident on the Tour flow (it checks their own applications on the server)", () => {
    expect(buildProspectTourHref("prop-1", resident, { applicationFirst: true })).toBe("/resident/tour/schedule?propertyId=prop-1");
  });
});

function Probe({ required }: { required: boolean }) {
  const gate = useTourApplicationGate({ id: "prop-1", applicationBeforeTour: required ? true : undefined });
  return <div data-testid="gate">{gate.status}</div>;
}

describe("useTourApplicationGate", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("is open without asking the server when the property does not require an application", () => {
    render(<Probe required={false} />);
    expect(screen.getByTestId("gate").textContent).toBe("open");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the visitor to apply first when the server says they have not applied", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ required: true, hasApplication: false }) } as never);
    render(<Probe required />);
    expect(screen.getByTestId("gate").textContent).toBe("checking");
    await waitFor(() => expect(screen.getByTestId("gate").textContent).toBe("apply_first"));
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("/api/public/tour-application-gate?propertyId=prop-1");
  });

  it("opens the flow once the server says they have applied", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ required: true, hasApplication: true }) } as never);
    render(<Probe required />);
    await waitFor(() => expect(screen.getByTestId("gate").textContent).toBe("open"));
  });
});

describe("useTourApplicationGate — approval matrix (reason from the server)", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function SignedInProbe() {
    const gate = useTourApplicationGate({ id: "prop-1", applicationBeforeTour: undefined }, { signedIn: true });
    return <div data-testid="gate">{gate.status}</div>;
  }

  it.each([
    [{ required: true, allowed: false, reason: "apply_first" }, "apply_first"],
    [{ required: true, allowed: false, reason: "pending_approval" }, "pending_approval"],
    [{ required: true, allowed: true, reason: null }, "open"],
    [{ required: false, allowed: false, reason: "denied" }, "denied"],
    [{ required: false, allowed: true, reason: null }, "open"],
  ])("signed in: %j reads %s, even when the property does not require an application", async (body, expected) => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => body } as never);
    render(<SignedInProbe />);
    await waitFor(() => expect(screen.getByTestId("gate").textContent).toBe(expected));
  });

  it("a signed-out visitor on a not-required property is never asked", () => {
    render(<Probe required={false} />);
    expect(screen.getByTestId("gate").textContent).toBe("open");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("TourApplicationFirstPanel", () => {
  afterEach(cleanup);

  it("pending approval and denied give the reason and no Apply door", () => {
    const { rerender } = render(<TourApplicationFirstPanel propertyId="prop-1" reason="pending_approval" />);
    expect(screen.getByText(/still being reviewed/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Apply" })).toBeNull();
    rerender(<TourApplicationFirstPanel propertyId="prop-1" reason="denied" />);
    expect(screen.getByText(/was denied/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Apply" })).toBeNull();
  });

  it("offers one Apply door for the property", () => {
    render(<TourApplicationFirstPanel propertyId="prop-1" propertyTitle="Maple House" />);
    const apply = screen.getByRole("link", { name: "Apply" });
    expect(apply.getAttribute("href")).toContain("prop-1");
    expect(screen.getByText(/asks for an approved application before a tour/i)).toBeTruthy();
  });
});
