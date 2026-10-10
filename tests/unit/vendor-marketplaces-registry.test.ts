import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ACCOUNT_PURGE_TABLES } from "@/lib/auth/account-purge-manifest";
import { parseVendorDirectoryTab, vendorListHref } from "@/lib/portal-detail-routes";
import {
  SERVICE_KINDS,
  SERVICE_LABELS,
  VENDOR_MARKETPLACE_DEFS,
  buildVendorJobPostText,
  isVendorMarketplaceId,
  marketplacePostUrl,
  marketplaceSearchUrl,
  marketplacesForService,
} from "@/lib/vendor-marketplaces/registry";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("vendor marketplace registry", () => {
  it("every marketplace has a unique id, a sign-up link, services and a guide", () => {
    const ids = VENDOR_MARKETPLACE_DEFS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of VENDOR_MARKETPLACE_DEFS) {
      expect(d.signupUrl).toMatch(/^https:\/\//);
      expect(d.services.length).toBeGreaterThan(0);
      expect(d.integration).toBe("coming_soon");
      expect(d.guide.how.length).toBeGreaterThan(0);
      expect(d.guide.cost.length).toBeGreaterThan(0);
      expect(d.guide.rules.length).toBeGreaterThan(0);
    }
  });

  it("every link it builds is a full https address on the marketplace, for every service it offers", () => {
    for (const d of VENDOR_MARKETPLACE_DEFS) {
      for (const service of d.services) {
        for (const url of [marketplaceSearchUrl(d, service, { zip: "98105", city: "Seattle" }), marketplacePostUrl(d, service, { zip: "98105" })]) {
          expect(() => new URL(url)).not.toThrow();
          expect(url).toMatch(/^https:\/\//);
        }
      }
    }
  });

  it("Yelp search carries the service and the house ZIP", () => {
    const yelp = VENDOR_MARKETPLACE_DEFS.find((d) => d.id === "yelp")!;
    expect(marketplaceSearchUrl(yelp, "handyman", { zip: "98105", city: "Seattle" })).toBe("https://www.yelp.com/search?find_desc=Handyman&find_loc=98105");
    expect(marketplaceSearchUrl(yelp, "handyman", {})).toBe("https://www.yelp.com/search?find_desc=Handyman");
  });

  it("covers the twelve services, reusing trade wording where a vendor trade already names it", () => {
    expect(SERVICE_KINDS).toHaveLength(12);
    for (const label of ["Plumbing", "Electrical", "HVAC", "Appliance repair", "Landscaping", "Cleaning", "Pest control"]) {
      expect(Object.values(SERVICE_LABELS)).toContain(label);
      expect(VENDOR_TRADE_OPTIONS as readonly string[]).toContain(label);
    }
    for (const service of SERVICE_KINDS) expect(marketplacesForService(service).length).toBeGreaterThan(0);
  });

  it("hides a marketplace that does not offer the service", () => {
    expect(marketplacesForService("handyman").map((d) => d.id)).toContain("taskrabbit");
    expect(marketplacesForService("locksmith").map((d) => d.id)).not.toContain("taskrabbit");
    expect(marketplacesForService("locksmith").map((d) => d.id)).not.toContain("handy");
  });

  it("only registry ids pass the id check", () => {
    expect(isVendorMarketplaceId("thumbtack")).toBe(true);
    expect(isVendorMarketplaceId("porch")).toBe(false);
    expect(isVendorMarketplaceId(undefined)).toBe(false);
  });

  it("the job post names the service and the area, never an address", () => {
    const text = buildVendorJobPostText({ service: "plumbing", city: "Seattle", zip: "98105" });
    expect(text).toContain("Plumbing needed in Seattle 98105");
    expect(buildVendorJobPostText({ service: "plumbing" })).toMatch(/^Plumbing needed\n/);
  });
});

describe("Vendors tab routing", () => {
  it("parses and links the Vendor services tab", () => {
    expect(parseVendorDirectoryTab("services")).toBe("services");
    expect(parseVendorDirectoryTab("catalog")).toBe("catalog");
    expect(parseVendorDirectoryTab("nope")).toBe("yours");
    expect(parseVendorDirectoryTab(null)).toBe("yours");
    expect(vendorListHref("/portal", "services")).toBe("/portal/vendors?tab=services");
    expect(vendorListHref("/portal", "catalog")).toBe("/portal/vendors?tab=catalog");
    expect(vendorListHref("/portal")).toBe("/portal/vendors");
  });

  it("the panel adds the tab after PropLane vendors with its data-attr", () => {
    const panel = read("src/components/portal/pro-vendors-panel.tsx");
    expect(panel.indexOf('dataAttr: "vendors-tab-catalog"')).toBeLessThan(panel.indexOf('dataAttr: "vendors-tab-services"'));
    expect(panel).toContain('label: "Vendor services"');
    expect(panel).toContain('directoryTab === "services" ? (');
  });
});

describe("vendor_marketplace_accounts table", () => {
  const sql = read("supabase/migrations/20261009170000_vendor_marketplace_accounts.sql");

  it("is service-role only: RLS on, no policy, no client grant, one row per workspace and marketplace", () => {
    expect(sql).toMatch(/alter table public\.vendor_marketplace_accounts enable row level security/i);
    expect(sql).toMatch(/revoke all on table public\.vendor_marketplace_accounts from anon, authenticated/i);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/grant [a-z, ]+ on table public\.vendor_marketplace_accounts to (anon|authenticated)/i);
    expect(sql).toMatch(/unique index if not exists [a-z_]+\s+on public\.vendor_marketplace_accounts \(workspace_id, marketplace\)/i);
    expect(sql).toMatch(/profile_url like 'https:\/\/%'/);
  });

  it("stores no credential column", () => {
    const columns = sql.replace(/--.*$/gm, "");
    expect(columns).not.toMatch(/\b(password|token|secret)\b/i);
  });

  it("is classified for account purge on the manager's id", () => {
    const rule = ACCOUNT_PURGE_TABLES.find((t) => t.table === "vendor_marketplace_accounts");
    expect(rule?.manager?.ids).toContain("manager_user_id");
  });
});
