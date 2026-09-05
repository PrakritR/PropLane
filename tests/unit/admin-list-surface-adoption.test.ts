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
  accounts: "src/components/portal/admin-axis-users-client.tsx",
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

/**
 * The header card is the other half of the house shape, and admin had four
 * different ones: labelled pill groups over Accounts, a bare pill strip on
 * Properties and Feedback, and Meetings' Availability button floating alone
 * above the card. All four are now the same counted-tab command header the
 * manager Properties and Tours tabs use.
 */
describe.each([
  ["properties", "src/components/portal/admin-properties-client.tsx"],
  ["feedback", "src/components/portal/admin-bug-feedback-client.tsx"],
  ["accounts", "src/components/portal/admin-axis-users-client.tsx"],
  ["meetings", "src/components/portal/admin-events-client.tsx"],
])("admin %s header", (_name, path) => {
  const src = read(path);

  it("uses the shared command header, not its own pill strip", () => {
    expect(src).toContain("PortalListControlStack");
    expect(src).toContain('variant="command"');
    expect(src).not.toContain("ManagerPortalStatusPills");
  });

  it("keeps the open tab in the URL so it can be linked", () => {
    // A tab that only lives in component state cannot be shared, and comes
    // back as whatever the default is every time the page is opened.
    expect(src).toContain("useSearchParams");
    expect(src).toMatch(/href: `\/admin\//);
  });
});

describe("admin Accounts", () => {
  const src = read(FILES.accounts);

  it("renders ONE list, not a table plus a parallel mobile card stack", () => {
    // Two renderings of the same rows from the same data is two places for the
    // list to drift; the desktop table and the mobile cards had already grown
    // different content.
    expect(src).not.toContain("PORTAL_MOBILE_CARD_CLASS");
    expect(src).not.toContain("<table");
    expect(src).toContain("PortalPersonRecordRow");
  });

  it("keeps account changes inside the editor the row opens", () => {
    // Enable / disable and plan changes are not one stray tick away in a dock.
    const dock = src.slice(src.indexOf("const bulkActions ="), src.indexOf("return (\n    <ManagerPortalPageShell"));
    expect(dock).toContain('data-attr="admin-account-open"');
    expect(dock).not.toContain("Disable");
  });
});
