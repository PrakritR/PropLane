/**
 * Admin borrows the house list surface; it does not invent one.
 *
 * Admin grew separately and showed it: Properties was a two-column table with a
 * chevron into a detail and no selection at all, and Feedback was a second
 * hand-rolled table. Both are now the same `PortalRecordListSurface` every
 * other list tab in every other portal uses, so the gutters, the selected-row
 * rail and the floating dock cannot drift apart from the rest of the product
 * again.
 *
 * This guards the adoption, not the markup: a tab that re-grows its own
 * `<table>` for the TOP-LEVEL list is the regression. Detail views and the
 * genuine record tables (Communication → Email) still use table primitives.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FILES = {
  properties: "src/components/portal/admin-properties-client.tsx",
  feedback: "src/components/portal/admin-bug-feedback-client.tsx",
} as const;

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe.each(Object.entries(FILES))("admin %s list", (_name, path) => {
  const src = read(path);

  it("renders the shared list surface", () => {
    expect(src).toContain("PortalRecordListSurface");
  });

  it("does not hand-roll a table for the list", () => {
    expect(src).not.toContain("PORTAL_DATA_TABLE_WRAP");
    expect(src).not.toContain("PORTAL_TABLE_HEAD_ROW");
  });

  it("selects with a leading checkbox, via a record row", () => {
    expect(src).toContain("onSelectedChange");
  });
});

describe("admin Properties", () => {
  const src = read(FILES.properties);

  it("keeps staff to viewing and (un)listing — never editing a manager's listing", () => {
    expect(src).toContain('data-attr="admin-property-view-listing"');
    expect(src).toContain('data-attr="admin-property-unlist"');
    expect(src).toContain('data-attr="admin-property-list"');
  });

  it("offers no ADD row, because admin does not create listings", () => {
    expect(src).not.toContain("PortalListAddRow");
    expect(src).not.toMatch(/\badd=\{/);
  });
});

describe("admin Feedback", () => {
  const src = read(FILES.feedback);

  it("moves status in bulk from the dock", () => {
    expect(src).toContain('data-attr={`admin-feedback-bulk-${o.value}`}');
  });

  it("keeps Delete in the row editor, not the dock", () => {
    // The one action here that cannot be undone stays behind the editor.
    const dock = src.slice(src.indexOf("const bulkActions = ("), src.indexOf("const renderList ="));
    expect(dock).not.toContain("Delete");
    expect(src).toContain("onDelete={() => void handleDelete(row)}");
  });
});
