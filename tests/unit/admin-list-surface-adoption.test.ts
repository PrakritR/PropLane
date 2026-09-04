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

describe("admin Settings", () => {
  const src = read("src/components/portal/portal-profile-client.tsx");

  it("takes the same grouped rail the manager has, not a second composition", () => {
    // There was one `if (variant === "manager")` return with the rail and a
    // second, legacy admin return below it that stacked every section in one
    // scroll. One shape now serves both.
    expect(src).not.toContain("Admin keeps the legacy single-scroll settings composition");
    expect(src.match(/<ManagerPortalPageShell\b/g)?.length).toBe(1);
    expect(src).toContain("PortalSettingsNav");
  });

  it("offers admin only the groups it actually has", () => {
    // Billing is a manager subscription, the work number is a manager's, and
    // API keys authorize against the manager tool layer.
    expect(src).toContain('if (!demo && variant === "manager") {');
    expect(src.match(/if \(!demo && variant === "manager"\) \{/g)?.length).toBe(3);
  });

  it("files an admin's own feedback as admin", () => {
    expect(src).toContain('reporterRole={variant === "admin" ? "admin"');
  });
});

describe("admin Meetings", () => {
  const src = read("src/components/portal/admin-events-client.tsx");

  it("lands on the requests, not the availability editor", () => {
    // The page used to open straight onto the week grid — an editor where the
    // list of people waiting on an answer belongs.
    expect(src).toContain("useState(false)");
    expect(src).toContain('data-attr="admin-meetings-availability-toggle"');
    expect(src).toContain("PortalRecordListSurface");
  });

  it("has the three status tabs that were missing entirely", () => {
    expect(src).toContain('dataAttr: "admin-meetings-tab-pending"');
    expect(src).toContain('dataAttr: "admin-meetings-tab-upcoming"');
    expect(src).toContain('dataAttr: "admin-meetings-tab-past"');
  });

  it("answers a request only where answering is possible", () => {
    // Confirmed and past meetings are a record; a dock there would offer
    // buttons that do nothing.
    expect(src).toContain('tab === "pending" ? (');
    expect(src).toContain('data-attr="admin-meeting-confirm"');
    expect(src).toContain('data-attr="admin-meeting-decline"');
  });
});
