// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

  it("carries the reading — Docs, MCP, Security under Learn; Reviews, About, Contact under Company — while Pricing, Service and Why are tabs", async () => {
    await openResourcesMenu();

    expect(screen.getAllByRole("link", { name: /documentation/i })[0]).toHaveAttribute("href", "/docs");
    expect(screen.getAllByRole("link", { name: /mcp & api/i })[0]).toHaveAttribute("href", "/docs/mcp");
    expect(screen.getAllByRole("link", { name: /security/i })[0]).toHaveAttribute("href", "/security");
    expect(screen.getAllByRole("link", { name: /reviews/i })[0]).toHaveAttribute("href", "/reviews");
    expect(screen.getAllByRole("link", { name: /about us/i })[0]).toHaveAttribute("href", "/about");
    expect(screen.getAllByRole("link", { name: /contact & support/i })[0]).toHaveAttribute("href", "/contact");
    // The iPhone app moved to the Product menu's featured panel (site round 2 §4).
    expect(screen.queryByRole("link", { name: /^mobile app$/i })).toBeNull();

    // Pricing is the second thing every buyer looks for: a top-level tab, not a
    // dropdown entry. Service sits immediately after Pricing, followed by Why PropLane.
    expect(screen.getAllByRole("link", { name: /^pricing$/i })[0]).toHaveAttribute("href", "/pricing");
    expect(screen.getAllByRole("link", { name: /^why proplane$/i })[0]).toHaveAttribute("href", "/why-proplane");
    const pricing = screen.getAllByRole("link", { name: /^pricing$/i })[0];
    const service = screen.getAllByRole("link", { name: /^service$/i })[0];
    expect(service).toHaveAttribute("href", "/service");
    expect(pricing.closest("li")?.nextElementSibling).toContainElement(service);
  });

  it("highlights the Pricing tab on /pricing, not Resources", async () => {
    mockPathname = "/pricing";
    render(<PublicNavbar />);

    const pricing = (await screen.findAllByRole("link", { name: /^pricing$/i }))[0];
    expect(pricing.className).toContain("text-primary");
    const trigger = (await screen.findAllByRole("button", { name: /resources/i }))[0];
    expect(trigger.className).not.toContain("text-primary");
  });

  it("highlights Service on its page without highlighting Pricing", async () => {
    mockPathname = "/service";
    render(<PublicNavbar />);
    expect((await screen.findAllByRole("link", { name: /^service$/i }))[0]).toHaveClass("text-primary");
    expect(screen.getAllByRole("link", { name: /^pricing$/i })[0]).not.toHaveClass("text-primary");
  });

  it("offers Start free and Book a demo on every page", async () => {
    render(<PublicNavbar />);
    expect((await screen.findAllByRole("link", { name: /start free/i })).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /book a demo/i })[0]).toHaveAttribute("href", "/contact?tab=schedule");
  });
});
