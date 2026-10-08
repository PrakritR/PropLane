import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("vendor directory 'Add to your vendors' confirmation (C272)", () => {
  it("confirms what the grant covers before adding a directory vendor to the roster", () => {
    const panel = read("src/components/portal/pro-vendors-panel.tsx");
    // The row action opens a confirm step rather than adding immediately.
    expect(panel).toContain("setPendingDirectoryAdd(row)");
    expect(panel).not.toMatch(/const add = \(\) => \(isDirectory \? void addDirectoryVendorToRoster/);
    // The confirm step names the visibility grant explicitly — no silent one-click add.
    expect(panel).toContain("will be able to see");
    expect(panel).toContain("service requests");
    expect(panel).toContain("confirmAddDirectoryVendor");
  });
});

describe("vendor directory filter discoverability (C256)", () => {
  it("keeps the filters in the one Filter popover, whose fields name what it covers (Category, Area, Rating)", () => {
    const panel = read("src/components/portal/pro-vendors-panel.tsx");
    expect(panel).toContain("PortalFilterSortSheet");
    expect(panel).toContain("VendorListFilterFields");
    const fields = read("src/components/portal/vendor-list-filter-fields.tsx");
    expect(fields).toContain('label="Category"');
    expect(fields).toContain("Area");
    expect(fields).toContain('label="Rating"');
  });
});
