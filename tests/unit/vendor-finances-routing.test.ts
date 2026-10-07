import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { vendorPortal, VENDOR_PORTAL_SMOKE_PATHS } from "@/lib/portals/vendor";

/**
 * Finances section wiring (vendor-banking-1006): five routed tabs, every old
 * vendor payments URL still resolving, and the migration + purge manifest for
 * the new W-9 table. Drives the real `renderPortalSection`, not a source shape.
 */
class RedirectError extends Error {
  constructor(public readonly to: string) {
    super(`NEXT_REDIRECT ${to}`);
  }
}
class NotFoundError extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectError(to);
  },
  notFound: () => {
    throw new NotFoundError();
  },
}));

const { renderPortalSection } = await import("@/lib/render-portal-section/vendor");

async function redirectOf(tabs: string[] | undefined): Promise<string | null> {
  try {
    await renderPortalSection("vendor", "financials", tabs);
    return null;
  } catch (error) {
    if (error instanceof RedirectError) return error.to;
    throw error;
  }
}

describe("vendor Finances routing", () => {
  it("registers five tabs under one Finances section", () => {
    const section = vendorPortal.sections.find((s) => s.section === "financials")!;
    expect(section.label).toBe("Finances");
    expect(section.tabs.map((t) => t.id)).toEqual(["balance", "income", "refunds", "statements", "tax"]);
    for (const tab of section.tabs) {
      expect(VENDOR_PORTAL_SMOKE_PATHS.some((p) => p.path === `/vendor/financials/${tab.id}`)).toBe(true);
    }
  });

  it("the bare section opens Balance & payouts", async () => {
    expect(await redirectOf(undefined)).toBe("/vendor/financials/balance");
    expect(await redirectOf([])).toBe("/vendor/financials/balance");
  });

  it.each(["balance", "income", "refunds", "statements", "tax"])("renders the %s tab", async (tab) => {
    expect(await renderPortalSection("vendor", "financials", [tab])).toBeTruthy();
  });

  it("renders a withdrawal's own page under Balance", async () => {
    expect(await renderPortalSection("vendor", "financials", ["balance", "po_123"])).toBeTruthy();
  });

  it("old vendor payments URLs keep resolving", async () => {
    // /vendor/payments → Payments
    expect(await redirectOf(undefined)).not.toBeNull();
    try {
      await renderPortalSection("vendor", "payments", undefined);
      throw new Error("expected a redirect");
    } catch (error) {
      expect((error as RedirectError).to).toBe("/vendor/financials/income");
    }
    // /financials/invoices (bare) → Payments; /financials/payouts (bare) → Balance & payouts
    expect(await redirectOf(["invoices"])).toBe("/vendor/financials/income");
    expect(await redirectOf(["payouts"])).toBe("/vendor/financials/balance");
    // /financials/income/pending (an old bucket URL) → Payments
    expect(await redirectOf(["income", "pending"])).toBe("/vendor/financials/income");
    // an invoice and a payment's own record pages still render
    expect(await renderPortalSection("vendor", "financials", ["invoices", "inv-1"])).toBeTruthy();
    expect(await renderPortalSection("vendor", "financials", ["payouts", "payout-1"])).toBeTruthy();
  });

  it("still 404s an unknown tab and a nested path under a list tab", async () => {
    await expect(renderPortalSection("vendor", "financials", ["bogus"])).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(renderPortalSection("vendor", "financials", ["statements", "2026-09"])).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("the Refunds tab mounts part B's VendorRefundsPanel", () => {
    const src = readFileSync("src/lib/render-portal-section.tsx", "utf8");
    expect(readFileSync("src/lib/render-portal-section/vendor.tsx", "utf8")).toContain(
      'import { VendorRefundsPanel } from "@/components/portal/vendor-refunds-panel";',
    );
    expect(src).toContain('<VendorRefundsPanel basePath={def.basePath} />');
    expect(readFileSync("src/components/portal/vendor-refunds-panel.tsx", "utf8")).toContain("export function VendorRefundsPanel(props: { basePath: string })");
  });

  it("Settings › Payouts links to Finances and the sidebar nests the five tabs", () => {
    const settings = readFileSync("src/components/portal/portal-payouts-settings-page.tsx", "utf8");
    expect(settings).toContain('href="/vendor/financials/balance"');
    const sidebar = readFileSync("src/components/portal/portal-sidebar.tsx", "utf8");
    expect(sidebar).toContain('definition.kind === "vendor" && section.section === "financials"');
  });
});

describe("vendor account W-9 table", () => {
  const sql = readFileSync("supabase/migrations/20261007010000_vendor_tax_profiles.sql", "utf8");

  it("is idempotent, RLS-on, and grants clients nothing", () => {
    expect(sql).toMatch(/create table if not exists public\.vendor_account_tax_profiles/);
    expect(sql).toMatch(/enable row level security/);
    expect(sql).toMatch(/revoke all on table public\.vendor_account_tax_profiles from anon, authenticated/);
    expect(sql).not.toMatch(/create policy|grant (select|all)/i);
    expect(sql).toMatch(/vendor_user_id uuid primary key references auth\.users/);
    expect(sql).not.toMatch(/\btin\b text|tin_plain/);
  });

  it("is classified in the account purge manifest", async () => {
    const { ACCOUNT_PURGE_TABLES } = await import("@/lib/auth/account-purge-manifest");
    expect(ACCOUNT_PURGE_TABLES.some((t) => t.table === "vendor_account_tax_profiles")).toBe(true);
  });
});
