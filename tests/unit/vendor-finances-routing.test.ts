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
  it("is ONE nav item with no sub-items; Overview, Payouts and Refunds are in-page tabs", () => {
    const section = vendorPortal.sections.find((s) => s.section === "financials")!;
    expect(section.label).toBe("Finances");
    expect(section.tabs).toEqual([]);
    for (const tab of ["overview", "payouts", "refunds"]) {
      expect(VENDOR_PORTAL_SMOKE_PATHS.some((p) => p.path === `/vendor/financials/${tab}`)).toBe(true);
    }
  });

  it("the bare section opens Overview", async () => {
    expect(await redirectOf(undefined)).toBe("/vendor/financials/overview");
    expect(await redirectOf([])).toBe("/vendor/financials/overview");
  });

  it.each(["overview", "payouts", "refunds"])("renders the %s tab", async (tab) => {
    expect(await renderPortalSection("vendor", "financials", [tab])).toBeTruthy();
  });

  it("the old Balance & payouts URL aliases into the Payouts tab", async () => {
    expect(await redirectOf(["balance"])).toBe("/vendor/financials/payouts");
  });

  it("renders a withdrawal's own page under the old balance path", async () => {
    expect(await renderPortalSection("vendor", "financials", ["balance", "po_123"])).toBeTruthy();
  });

  it("old vendor payments URLs keep resolving (Payments moved to Incoming payments)", async () => {
    try {
      await renderPortalSection("vendor", "payments", undefined);
      throw new Error("expected a redirect");
    } catch (error) {
      expect((error as RedirectError).to).toBe("/vendor/payments/pending");
    }
    // /financials/invoices (bare) and /financials/income -> Incoming payments; /financials/payouts (bare) is the Payouts tab
    expect(await redirectOf(["invoices"])).toBe("/vendor/payments/pending");
    expect(await redirectOf(["income"])).toBe("/vendor/payments/pending");
    expect(await redirectOf(["payouts"])).toBeNull();
    // Statements and Tax info moved into Documents
    expect(await redirectOf(["statements"])).toBe("/vendor/documents/statements");
    expect(await redirectOf(["tax"])).toBe("/vendor/documents/tax");
    // an invoice and a payment's own record pages still render
    expect(await renderPortalSection("vendor", "financials", ["invoices", "inv-1"])).toBeTruthy();
    expect(await renderPortalSection("vendor", "financials", ["payouts", "payout-1"])).toBeTruthy();
  });

  it("still 404s an unknown tab and a nested path under a list tab", async () => {
    await expect(renderPortalSection("vendor", "financials", ["bogus"])).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(renderPortalSection("vendor", "financials", ["refunds", "2026-09"])).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("the Refunds tab mounts VendorRefundsPanel inside the one Finances page", () => {
    expect(readFileSync("src/components/portal/vendor-finances-balance.tsx", "utf8")).toContain("<VendorRefundsPanel");
    expect(readFileSync("src/components/portal/vendor-refunds-panel.tsx", "utf8")).toContain("export function VendorRefundsPanel(props: {");
  });

  it("Settings › Payouts links to the Finances Payouts tab", () => {
    const settings = readFileSync("src/components/portal/portal-payouts-settings-page.tsx", "utf8");
    expect(settings).toContain('href="/vendor/financials/payouts"');
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
