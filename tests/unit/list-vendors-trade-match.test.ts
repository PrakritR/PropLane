import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));

import { vendorMatchesTradeQuery } from "@/lib/tools/domains/vendors";

describe("list_vendors trade filter", () => {
  it("finds a vendor filed as Plumber when asked for plumbing", () => {
    expect(vendorMatchesTradeQuery({ trade: "Plumber", trades: ["Plumber"] }, "plumbing")).toBe(true);
    expect(vendorMatchesTradeQuery({ trade: "Plumber" }, "plumber")).toBe(true);
    expect(vendorMatchesTradeQuery({ trade: "Electrician" }, "electrical")).toBe(true);
  });

  it("does not match a different trade", () => {
    expect(vendorMatchesTradeQuery({ trade: "Plumber" }, "locksmith")).toBe(false);
    expect(vendorMatchesTradeQuery({ trade: "Electrician" }, "plumbing")).toBe(false);
  });

  it("an empty query matches everyone", () => {
    expect(vendorMatchesTradeQuery({ trade: "Cleaner" }, "  ")).toBe(true);
  });
});
