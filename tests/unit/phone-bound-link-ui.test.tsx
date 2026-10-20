// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("@/components/stripe-embedded-checkout", () => ({
  StripeEmbeddedCheckout: ({ clientSecret, onComplete }: { clientSecret: string; onComplete?: () => void }) => (
    <div data-testid="embedded-checkout" data-secret={clientSecret}>
      <button onClick={onComplete}>finish-payment</button>
    </div>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: nav.refresh, push: nav.push }) }));

import { PublicTextingProvider } from "@/components/marketing/public-texting-context";
import { LinkCodeGate, LinkExpiredView, PublicPhoneBindForm, RentLinkCard } from "@/components/public/phone-bound-link-ui";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  nav.refresh.mockReset();
  nav.push.mockReset();
});

describe("LinkExpiredView", () => {
  it("says it has expired and what to do, nothing about why", () => {
    const { container } = render(<LinkExpiredView />);
    expect(container.querySelector("h1")?.textContent).toBe("This link has expired");
    // No number configured in this render: a plain line, never a hard-coded number.
    expect(container.textContent).toBe("This link has expiredAsk for a new link.Find a home");
    expect(container.querySelector("a[href='/rent/browse']")?.textContent).toBe("Find a home");
    expect(container.textContent).not.toMatch(/\d{3}[-\s)]*\d{3}[-\s]?\d{4}/);
  });

  it("links the configured number when the line is live", () => {
    const { container } = render(
      <PublicTextingProvider value={{ phone: "+12065550142", smsHref: null }}>
        <LinkExpiredView />
      </PublicTextingProvider>,
    );
    const link = container.querySelector("[data-attr='phone-link-expired-text']") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toMatch(/^sms:\+12065550142/);
    expect(link.textContent).toBe("(206) 555-0142");
    expect(container.textContent).toContain("for a new one.");
  });
});

describe("LinkCodeGate", () => {
  it("shows only the send step first, reveals nothing about the target, then asks for the code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<LinkCodeGate token={"T".repeat(43)} />);
    expect(container.textContent).not.toMatch(/\d{3}[-\s]?\d{3}[-\s]?\d{4}/);
    expect(container.querySelector("h1")?.textContent).toBe("Confirm it's you");
    fireEvent.click(screen.getByText("Text me a code"));
    await waitFor(() => expect(screen.getByLabelText("Code")).toBeTruthy());
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/l/${"T".repeat(43)}/code`);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ action: "send" });
  });

  it("refreshes the page once the code is accepted, and shows the refusal otherwise", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { ok: true }))
      .mockResolvedValueOnce(json(400, { error: "That code did not work." }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<LinkCodeGate token={"T".repeat(43)} />);
    fireEvent.click(screen.getByText("Text me a code"));
    const input = await screen.findByLabelText("Code");
    fireEvent.change(input, { target: { value: "12ab34" } });
    expect((input as HTMLInputElement).value).toBe("1234");
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByText("Verify"));
    await screen.findByText("That code did not work.");
    expect(nav.refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Verify"));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });
});

describe("RentLinkCard", () => {
  const charges = [{ id: "c1", title: "October rent", amountLabel: "$1,200.00", propertyLabel: "5259 Brooklyn" }];

  it("lists the live charges and sends only the token to start checkout", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(422, { error: "Card is not accepted for this charge.", signInHref: "/auth/sign-in?next=%2Fresident%2Fpayments" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RentLinkCard token={"R".repeat(43)} charges={charges} />);
    expect(screen.getByText("October rent")).toBeTruthy();
    expect(screen.getAllByText("$1,200.00").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Pay $1,200.00"));
    await screen.findByText("Card is not accepted for this charge.");
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/l/${"R".repeat(43)}/rent-checkout`);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({});
    expect(screen.getByText("Sign in to PropLane").closest("a")?.getAttribute("href")).toBe("/auth/sign-in?next=%2Fresident%2Fpayments");
  });
});

describe("RentLinkCard in-page payment", () => {
  const charges = [{ id: "c1", title: "3 nights at $120/night", amountLabel: "$360.00", propertyLabel: "Maple House" }];

  it("opens the payment form on the page and never leaves it", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetchMock = vi.fn().mockResolvedValue(json(200, { clientSecret: "cs_test_abc" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RentLinkCard token={"S".repeat(43)} charges={charges} />);
    fireEvent.click(screen.getByText("Pay $360.00"));
    const form = await screen.findByTestId("embedded-checkout");
    expect(form.getAttribute("data-secret")).toBe("cs_test_abc");
    expect(assign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("finish-payment"));
    await screen.findByText("Payment received");
  });
});

describe("PublicPhoneBindForm", () => {
  it("asks for a phone, texts a code, then goes to the bound link", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { ok: true }))
      .mockResolvedValueOnce(json(200, { ok: true, href: `/l/${"B".repeat(43)}` }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicPhoneBindForm code="BROOKLYN5" kind="apply" heading="Apply" />);
    expect(screen.getByText("Apply")).toBeTruthy();
    const phone = screen.getByPlaceholderText("Mobile number");
    fireEvent.change(phone, { target: { value: "2065550142" } });
    fireEvent.click(screen.getByText("Text me a code"));
    const code = await screen.findByLabelText("Code");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ code: "BROOKLYN5", kind: "apply", action: "send" });
    fireEvent.change(code, { target: { value: "654321" } });
    fireEvent.click(screen.getByText("Verify"));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/l/${"B".repeat(43)}`));
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({ action: "verify", otp: "654321" });
  });

  it("never navigates to anything but a /l/ link", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { ok: true }))
      .mockResolvedValueOnce(json(200, { ok: true, href: "https://evil.example/" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicPhoneBindForm code="BROOKLYN5" kind="tour" heading="Book a tour" />);
    fireEvent.change(screen.getByPlaceholderText("Mobile number"), { target: { value: "2065550142" } });
    fireEvent.click(screen.getByText("Text me a code"));
    const code = await screen.findByLabelText("Code");
    fireEvent.change(code, { target: { value: "654321" } });
    fireEvent.click(screen.getByText("Verify"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(nav.push).not.toHaveBeenCalled();
  });
});
