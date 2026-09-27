// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
  }),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
}));

import { PublicNavbar } from "@/components/layout/public-navbar";

describe("public navbar assistant placement", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not mount Ask PropLane in the marketing header — the FAB owns public entry", () => {
    render(<PublicNavbar />);

    expect(document.querySelector("#axis-public-navbar [data-attr='general-assistant-open']")).toBeNull();
    expect(document.querySelector("#axis-public-navbar [data-attr='general-assistant-fab']")).toBeNull();
  });
});
