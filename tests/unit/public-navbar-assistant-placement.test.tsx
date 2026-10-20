// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => {
    throw new Error("Public navigation must not initialize auth");
  },
}));
vi.mock("@/components/marketing/fonts/home-swiss-font", () => ({ homeSwissFont: { variable: "swiss-font" } }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
}));

import { PublicNavbar } from "@/components/layout/public-navbar";
import { publicTextingConfig } from "@/lib/marketing/public-texting";

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("public navbar assistant placement", () => {
  it("does not mount Ask PropLane in the marketing header — the FAB owns public entry", () => {
    render(<PublicNavbar texting={publicTextingConfig("+12065550123")} />);

    expect(document.querySelector("#axis-public-navbar [data-attr='general-assistant-open']")).toBeNull();
    expect(document.querySelector("#axis-public-navbar [data-attr='general-assistant-fab']")).toBeNull();
  });
});
