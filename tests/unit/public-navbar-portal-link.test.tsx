// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// Per-test control of the "signed-in role" the navbar resolves. The navbar's
// syncAuth() reads a session, then the profile role from `profiles`.
let mockRole: "resident" | "manager" | "vendor" | "admin" | null = null;

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: mockRole ? { user: { id: "u1", user_metadata: {} } } : null },
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: () => ({
      select: () => ({
        // profiles.select("role").eq("id").maybeSingle()
        // profile_roles.select("role").eq("user_id") — awaited directly
        eq: () => ({
          maybeSingle: async () => ({ data: mockRole ? { role: mockRole } : null }),
          then: (resolve: (v: { data: null }) => unknown) => resolve({ data: null }),
        }),
      }),
    }),
  }),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

// jsdom throws on native localStorage for opaque origins; install an in-memory
// store the navbar's readSignedInFromStorage()/persistSignedIn() can use.
const store = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};
vi.stubGlobal("localStorage", fakeLocalStorage);

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

import { PublicNavbar } from "@/components/layout/public-navbar";

const ROLE_HOME: Record<NonNullable<typeof mockRole>, string> = {
  resident: "/resident",
  manager: "/portal/dashboard",
  vendor: "/vendor/dashboard",
  admin: "/admin/dashboard",
};

describe("public navbar signed-in portal link", () => {
  beforeEach(() => {
    localStorage.setItem("axis:signed_in", "1");
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    mockRole = null;
  });

  for (const role of ["resident", "manager", "vendor", "admin"] as const) {
    it(`reads "Portal" and links straight to the ${role} portal home`, async () => {
      mockRole = role;
      render(<PublicNavbar />);

      const portalLink = await waitFor(() => {
        const link = screen.getAllByRole("link", { name: /^portal$/i })[0];
        expect(link).toBeTruthy();
        return link;
      });

      expect(portalLink).toHaveTextContent(/^Portal$/);
      expect(portalLink).toHaveAttribute("href", ROLE_HOME[role]);
    });
  }

  it("shows no portal link and keeps Log in / Start free when signed out", async () => {
    mockRole = null;
    localStorage.removeItem("axis:signed_in");
    render(<PublicNavbar />);

    await waitFor(() => {
      expect(screen.getAllByRole("link", { name: /log in/i }).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByRole("link", { name: /start free/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: /^portal$/i })).toBeNull();
  });
});
