// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The navbar boots a Supabase browser client in an effect; stub it so the
// component mounts without public Supabase env.
vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null }) }),
      }),
    }),
  }),
}));

// Radix's navigation menu measures its viewport; jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

let mockPathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
}));

import { LegacyPublicNavbar as PublicNavbar } from "@/components/layout/legacy-public-navbar";

async function openResourcesMenu() {
  const user = userEvent.setup();
  render(<PublicNavbar />);
  const trigger = (await screen.findAllByRole("button", { name: /resources/i }))[0];
  await user.click(trigger);
  await waitFor(() => expect(screen.getAllByRole("link", { name: /documentation/i }).length).toBeGreaterThan(0));
}

describe("public navbar Resources dropdown", () => {
  afterEach(() => {
    cleanup();
    mockPathname = "/";
  });

  it("carries the reading — Docs, MCP, Security under Learn; Reviews, About, Contact under Company — while Pricing and Why are menus beside Service", async () => {
    await openResourcesMenu();

    expect(screen.getAllByRole("link", { name: /documentation/i })[0]).toHaveAttribute("href", "/docs");
    expect(screen.getAllByRole("link", { name: /mcp & api/i })[0]).toHaveAttribute("href", "/docs/mcp");
    expect(screen.getAllByRole("link", { name: /security/i })[0]).toHaveAttribute("href", "/security");
    expect(screen.getAllByRole("link", { name: /reviews/i })[0]).toHaveAttribute("href", "/reviews");
    expect(screen.getAllByRole("link", { name: /about us/i })[0]).toHaveAttribute("href", "/about");
    expect(screen.getAllByRole("link", { name: /contact & support/i })[0]).toHaveAttribute("href", "/contact");
    // The iPhone app moved to the Product menu's featured panel (site round 2 §4).
    expect(screen.queryByRole("link", { name: /^mobile app$/i })).toBeNull();

    const pricing = screen.getAllByRole("button", { name: /^pricing$/i })[0];
    expect(screen.getAllByRole("button", { name: /^why proplane$/i })[0]).toBeInTheDocument();
    const service = screen.getAllByRole("link", { name: /^service$/i })[0];
    expect(service).toHaveAttribute("href", "/service");
    expect(pricing.closest("li")?.nextElementSibling).toContainElement(service);
  });

  it.each(["/pricing", "/pricing/service"])("highlights Pricing on %s, not Resources", async (pathname) => {
    mockPathname = pathname;
    render(<PublicNavbar />);

    const pricing = (await screen.findAllByRole("button", { name: /^pricing$/i }))[0];
    expect(pricing.className).toContain("text-primary");
    const trigger = (await screen.findAllByRole("button", { name: /resources/i }))[0];
    expect(trigger.className).not.toContain("text-primary");
  });

  it("highlights Service on its page without highlighting Pricing", async () => {
    mockPathname = "/service";
    render(<PublicNavbar />);
    expect((await screen.findAllByRole("link", { name: /^service$/i }))[0]).toHaveClass("text-primary");
    expect(screen.getAllByRole("button", { name: /^pricing$/i })[0]).not.toHaveClass("text-primary");
  });

  it("offers both pricing destinations and marks the selected child", async () => {
    mockPathname = "/pricing/service";
    const user = userEvent.setup();
    render(<PublicNavbar />);
    await user.click((await screen.findAllByRole("button", { name: "Pricing" }))[0]);
    expect(screen.getByRole("link", { name: "Software" })).toHaveAttribute("href", "/pricing");
    expect(screen.getByRole("link", { name: "Managed service" })).toHaveAttribute("href", "/pricing/service");
    expect(screen.getByRole("link", { name: "Managed service" })).toHaveClass("text-primary", "min-h-[44px]");
  });

  it("offers all Why PropLane destinations and highlights the nested page", async () => {
    mockPathname = "/why-proplane/track-record";
    const user = userEvent.setup();
    render(<PublicNavbar />);
    const why = (await screen.findAllByRole("button", { name: "Why PropLane" }))[0];
    expect(why).toHaveClass("text-primary");
    await user.click(why);
    for (const [name, href] of [["Overview", "/why-proplane"], ["Our track record", "/why-proplane/track-record"], ["How we manage", "/why-proplane/how-we-manage"], ["The software", "/why-proplane/software"]]) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
    }
    expect(screen.getByRole("link", { name: "Our track record" })).toHaveClass("text-primary");
  });

  it("uses the same Pricing and Why PropLane menus in the mobile sheet", async () => {
    const user = userEvent.setup();
    render(<PublicNavbar />);
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    const sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: "Pricing" }));
    expect(within(sheet).getByRole("link", { name: "Software" })).toHaveAttribute("href", "/pricing");
    expect(within(sheet).getByRole("link", { name: "Managed service" })).toHaveAttribute("href", "/pricing/service");
    await user.click(within(sheet).getByRole("button", { name: "Why PropLane" }));
    for (const [name, href] of [["Overview", "/why-proplane"], ["Our track record", "/why-proplane/track-record"], ["How we manage", "/why-proplane/how-we-manage"], ["The software", "/why-proplane/software"]]) {
      expect(within(sheet).getByRole("link", { name })).toHaveAttribute("href", href);
    }
  });

  it("links Product's AI assistant directly to the software page", async () => {
    const user = userEvent.setup();
    render(<PublicNavbar />);
    await user.click((await screen.findAllByRole("button", { name: "Product" }))[0]);
    expect(screen.getByRole("link", { name: /^AI assistant/ })).toHaveAttribute("href", "/why-proplane/software");
  });

  it("offers Start free and Book a demo on every page", async () => {
    render(<PublicNavbar />);
    expect((await screen.findAllByRole("link", { name: /start free/i })).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /book a demo/i })[0]).toHaveAttribute("href", "/contact?tab=schedule");
  });
});
