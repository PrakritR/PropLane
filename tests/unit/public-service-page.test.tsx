// @vitest-environment jsdom
//
// The texted-link page (vendor-work-share-1006): signed-out it shows the allowlisted job and NO
// address; choosing an option parks the link in a cookie and sends a signed-out visitor to create an
// account; for a signed-in vendor it redeems the link and opens the job on the right tab.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ token: "tok_abcdefghijklmnopqrstuvwxyz012345" }),
  useRouter: () => ({ push }),
  usePathname: () => "/s/tok",
}));

import { PublicServicePage } from "@/components/public/public-service-page";

const SERVICE = {
  title: "Kitchen sink leak",
  trade: "Plumbing",
  area: "Seattle",
  description: "Slow leak under the sink.",
  when: "weekdays after 5pm",
  budget: "Up to $250",
  photos: [] as string[],
  postedBy: "Alder Property Co",
};

let redeemStatus = 401;
let state: "open" | "closed" = "open";

beforeEach(() => {
  push.mockReset();
  document.cookie = "pl_svc_link=; path=/; max-age=0";
  redeemStatus = 401;
  state = "open";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/public/service-link/")) {
        return new Response(JSON.stringify({ service: SERVICE, state }), { status: 200 });
      }
      if (String(url) === "/api/vendor/service-link/redeem") {
        return redeemStatus === 200
          ? new Response(JSON.stringify({ ok: true, workOrderId: "wo-9", choice: "estimate", alreadyHeld: false }), { status: 200 })
          : new Response(JSON.stringify({ error: "nope" }), { status: redeemStatus });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PublicServicePage", () => {
  it("shows the job and never an address, and offers the three options plus sign in", async () => {
    render(<PublicServicePage />);
    expect(await screen.findByText("Kitchen sink leak")).toBeTruthy();
    expect(screen.getByText("Plumbing · Seattle")).toBeTruthy();
    expect(screen.getByText("Up to $250")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Needs an estimate visit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bid now" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Message the manager" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "I have an account" })).toBeTruthy();
    expect(screen.getByText(/address is shared once you're hired/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d{3,5} [A-Z][a-z]+ (St|Ave|Rd)|Unit|98115/);
  });

  it("the choices are primary actions in the page header, above the description, not a strip at the bottom", async () => {
    render(<PublicServicePage />);
    await screen.findByText("Kitchen sink leak");
    const header = document.querySelector('[data-attr="public-service-header"]')!;
    expect(header.querySelector('[data-attr="public-service-actions"]')).toBeTruthy();
    expect(header.querySelector('[data-attr="public-service-bid"]')).toBeTruthy();
    const page = document.querySelector('[data-attr="public-service-page"]')!;
    const description = screen.getByText("Slow leak under the sink.");
    expect(header.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(page.querySelectorAll('[data-attr="public-service-actions"]')).toHaveLength(1);
  });

  it("signed out: parks the link in a cookie and goes to vendor sign-up", async () => {
    render(<PublicServicePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Bid now" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/auth/create-account?mode=create&role=vendor"));
    expect(decodeURIComponent(document.cookie)).toContain('"choice":"bid"');
    expect(decodeURIComponent(document.cookie)).toContain("tok_abcdefghijklmnopqrstuvwxyz012345");
  });

  it("signed-in vendor: redeems and opens the job on the chosen tab", async () => {
    redeemStatus = 200;
    render(<PublicServicePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Needs an estimate visit" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/vendor/work-orders/wo-9/bid?choice=estimate"));
  });

  it("message routes to the in-app conversation", async () => {
    redeemStatus = 200;
    render(<PublicServicePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Message the manager" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/vendor/work-orders/wo-9/communication"));
  });

  it("a filled job offers no actions", async () => {
    state = "closed";
    render(<PublicServicePage />);
    expect(await screen.findByText("This job has been filled.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Bid now" })).toBeNull();
  });

  it("an expired link shows only a neutral message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "This link has expired or is no longer valid." }), { status: 404 })));
    render(<PublicServicePage />);
    expect(await screen.findByText("Link unavailable")).toBeTruthy();
  });
});
