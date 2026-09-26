import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Cross-portal terminology unification (captain 2026-09-26):
 * - "Inbox" → "Communication" (section, nav, page title, card title)
 * - "Messages" → "Communication" (label)
 * - "tenant/tenants" → "resident/residents" (portal UI copy)
 * - "bid" → "quote" (vendor side: labels, buttons, toasts)
 * - "Maintenance request" / "Maintenance visit" → "Service request" / "Service visit"
 * - "Maintenance" KIND survives (data model distinction vs "Add-on service")
 * - "Other" → "Other documents" (documents tab label)
 * - "Manage properties & tenants" → "Manage properties & residents"
 *
 * This scan is the guard on that split. It looks at rendered copy — quoted
 * strings and JSX text — and ignores identifiers, attributes and comments.
 */
function walk(dir: string, exts: string[]): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path, exts);
    return exts.some((ext) => path.endsWith(ext)) ? [path] : [];
  });
}

/** A line is exempt when the phrase there is an identifier, not copy. */
const EXEMPT = [
  "isPropLaneAssistantInboxThread",
  "ResidentMaintenanceCategoryLabel",
  "isMaintenanceServiceOffer",
  "resolveDefaultVendorForMaintenance",
  "submitMaintenanceServiceIntake",
  "inboxThread",
  "loadPersistedInbox",
  "changePersistedInboxThreadFolders",
  "mergeInboxScopedContacts",
  "deliverPortalInboxMessage",
  "ResidentUnifiedInbox",
  "InboxScheduledCard",
  "InboxScheduledThreadList",
  "InboxListSegmentRail",
  "PortalInboxEmptyState",
  "InboxConversationListAddRow",
  "InboxRecipientScope",
  "InboxComposeRecipients",
  "tenantId",
  "tenant_",
  "workOrder",
  "WorkOrder",
  "work-order",
  "work_order",
  "maintenance",
  "Maintenance",
  "MAINTENANCE",
  "data-attr",
  "className",
  "import ",
  'from "',
  "// ",
  "/* ",
];

/**
 * Portal sections/nav that are OK with "Inbox" because they are code identifiers
 * or have special allowances.
 */
const EXEMPT_PATHS = new Set([
  join("src", "lib", "portals", "resident-sections.ts"),
  join("src", "lib", "portals", "manager-sections.ts"),
  join("src", "lib", "portals", "admin-sections.ts"),
  join("src", "lib", "portals", "vendor-sections.ts"),
  join("src", "components", "portal", "portal-detail-routes.ts"),
  join("src", "components", "portal", "portal-inbox-ui.tsx"), // internal renderer, legacy "Inbox" in comments OK
  join("src", "components", "marketing", "site", "bento.tsx"), // demo/marketing only
  join("src", "app", "(public)", "partner", "page.tsx"), // demo/marketing only
]);

describe("portal terminology consistency", () => {
  it("never shows 'Inbox' as a portal section/nav/page title (Communication instead)", () => {
    const offenders: string[] = [];
    const files = [
      ...walk(join("src", "components", "portal"), [".tsx"]),
      ...walk(join("src", "app"), [".tsx"]),
    ];

    for (const file of files) {
      if (EXEMPT_PATHS.has(file)) continue;

      for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
        if (EXEMPT.some((token) => line.includes(token))) continue;

        // Check for "Inbox" as a title, label, or placeholder
        if (/title\s*=\s*["']Inbox["']|label\s*:\s*["']Inbox["']|placeholder\s*=\s*["']Inbox["']/.test(line)) {
          offenders.push(`${file}:${index + 1} ${trimmed.slice(0, 100)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never shows 'tenant/tenants' in portal UI copy (resident/residents instead)", () => {
    const offenders: string[] = [];
    const files = [
      ...walk(join("src", "components", "portal"), [".tsx"]),
      ...walk(join("src", "app"), [".tsx"]),
    ];

    for (const file of files) {
      for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
        if (EXEMPT.some((token) => line.includes(token))) continue;

        // Check for "tenant" or "tenants" in quoted strings or JSX text (UI copy)
        // Exclude code identifiers like tenant_email, tenantId, etc.
        if (
          /["'].*\btenants?\b.*["']/.test(line) &&
          !/"[^"]*_tenant|tenant_/.test(line) &&
          !/"[^"]*Tenant[^"]*"/.test(line)
        ) {
          // Check it's actually user-facing copy (contains label, title, placeholder, aria, hint, etc.)
          if (/label|title|placeholder|aria|hint|toContain|toContain/.test(line)) {
            offenders.push(`${file}:${index + 1} ${trimmed.slice(0, 100)}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never shows 'bid' in vendor UI copy (quote instead)", () => {
    const offenders: string[] = [];
    const files = [
      ...walk(join("src", "components", "portal"), [".tsx"]),
      ...walk(join("src", "app"), [".tsx"]),
    ];

    for (const file of files) {
      // Only check vendor-related files
      if (!file.includes("vendor") && !file.includes("work-order") && !file.includes("pro-work")) continue;

      for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
        if (EXEMPT.some((token) => line.includes(token))) continue;

        // Check for "bid" in UI copy (not code identifiers like bidId, bid.status, etc.)
        if (
          /["'].*\bbid\b.*["']|>\s*bid\s*</i.test(line) &&
          !/bid[A-Z]|bidId|bid\.|bid\s*\)|\(bid/i.test(line)
        ) {
          offenders.push(`${file}:${index + 1} ${trimmed.slice(0, 100)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never shows 'Maintenance request' in UI (Service request instead)", () => {
    const offenders: string[] = [];
    const files = [
      ...walk(join("src", "components", "portal"), [".tsx"]),
      ...walk(join("src", "app"), [".tsx"]),
    ];

    for (const file of files) {
      for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
        if (EXEMPT.some((token) => line.includes(token))) continue;

        // Check for "Maintenance request" or "Maintenance visit" in copy
        if (/["'].*Maintenance\s+(?:request|visit).*["']|>\s*Maintenance\s+(?:request|visit)\s*</i.test(line)) {
          offenders.push(`${file}:${index + 1} ${trimmed.slice(0, 100)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
