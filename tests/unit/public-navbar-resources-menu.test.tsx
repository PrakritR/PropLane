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
}));

import { PublicNavbar } from "@/components/layout/public-navbar";

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

  it("carries the reading — Docs, MCP, Mobile app, Security, Reviews, About — while Pricing and Why are tabs", async () => {
    await openResourcesMenu();

    expect(screen.getAllByRole("link", { name: /documentation/i })[0]).toHaveAttribute("href", "/docs");
    expect(screen.getAllByRole("link", { name: /mobile app/i })[0]).toHaveAttribute("href", "/app");
    expect(screen.getAllByRole("link", { name: /security/i })[0]).toHaveAttribute("href", "/security");
    expect(screen.getAllByRole("link", { name: /reviews/i })[0]).toHaveAttribute("href", "/reviews");
    expect(screen.getAllByRole("link", { name: /about us/i })[0]).toHaveAttribute("href", "/about");

    // Pricing is the second thing every buyer looks for: a top-level tab, not a
    // dropdown entry. Why PropLane sits beside it.
    expect(screen.getAllByRole("link", { name: /^pricing$/i })[0]).toHaveAttribute("href", "/pricing");
    expect(screen.getAllByRole("link", { name: /^why proplane$/i })[0]).toHaveAttribute("href", "/why-proplane");
  });

  it("highlights the Pricing tab on /pricing, not Resources", async () => {
    mockPathname = "/pricing";
    render(<PublicNavbar />);

    const pricing = (await screen.findAllByRole("link", { name: /^pricing$/i }))[0];
    expect(pricing.className).toContain("text-primary");
    const trigger = (await screen.findAllByRole("button", { name: /resources/i }))[0];
    expect(trigger.className).not.toContain("text-primary");
  });

  it("offers Start free and Book a demo on every page", async () => {
    render(<PublicNavbar />);
    expect((await screen.findAllByRole("link", { name: /start free/i })).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /book a demo/i })[0]).toHaveAttribute("href", "/contact?tab=schedule");
  });
});
