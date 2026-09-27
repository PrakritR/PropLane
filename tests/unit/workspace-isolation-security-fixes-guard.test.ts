import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source guard for the 2026-09-27 workspace-isolation security pass
 * (workspace-isolation-audit-0927.md, findings W001-W008/W010/W011).
 *
 * Each fixed surface below reads a manager-scoped table and must keep calling
 * one of the shared workspace/co-manager scope primitives
 * (`src/lib/workspaces/*`, `src/lib/auth/co-manager-*`,
 * `src/lib/agent/manager-workspace-scope.ts`). This is a REGRESSION guard,
 * not a repo-wide sweep: it pins the exact files this pass touched so a later
 * edit that quietly deletes the added scope call fails a test immediately,
 * the same way `resident-role-authorization-surface.test.ts` pins migrated
 * routes rather than re-deriving the whole set from scratch every run.
 */

const ROOT = process.cwd();

function code(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const FIXED_SURFACES: { finding: string; path: string; requiredPattern: RegExp }[] = [
  {
    finding: "W001",
    path: "src/lib/mcp/context.server.ts",
    requiredPattern: /resolveApiKeyWorkspaceScope|workspace:\s*workspace/,
  },
  {
    finding: "W001",
    path: "src/app/api/manager/api-keys/route.ts",
    requiredPattern: /listViewerWorkspaces|workspaceId/,
  },
  {
    finding: "W001",
    path: "src/app/api/mcp/oauth/approve/route.ts",
    requiredPattern: /actor\.workspace/,
  },
  {
    finding: "W002",
    path: "src/app/api/manager-bills/route.ts",
    requiredPattern: /resolvePropertyPayoutOwner|fetchRowsForManagerWithLinked/,
  },
  {
    finding: "W003",
    path: "src/app/api/manager-budgets/route.ts",
    requiredPattern: /assertManagerFinancialsCoManagerAccess/,
  },
  {
    finding: "W003",
    path: "src/app/api/manager-owner-distributions/route.ts",
    requiredPattern: /assertManagerFinancialsCoManagerAccess/,
  },
  {
    finding: "W004",
    path: "src/app/api/property-records/route.ts",
    requiredPattern: /activeWorkspacePropertyScope/,
  },
  {
    finding: "W005",
    path: "src/app/api/portal-lease-pipeline/route.ts",
    requiredPattern: /assertPropertyInActiveWorkspace/,
  },
  {
    finding: "W006",
    path: "src/lib/resident-approval.server.ts",
    requiredPattern: /residentPropertyIdsForManager|activeWorkspacePropertyScope/,
  },
  {
    finding: "W007",
    path: "src/app/api/portal-vendors/route.ts",
    requiredPattern: /resolveActiveWorkspaceRowScope|vendorRowInWorkspaceScope/,
  },
  {
    finding: "W008",
    path: "src/lib/tools/domains/applications.ts",
    requiredPattern: /rowAllowedInAgentWorkspace/,
  },
  {
    finding: "W008",
    path: "src/lib/tools/domains/work-orders.ts",
    requiredPattern: /rowAllowedInAgentWorkspace/,
  },
  {
    finding: "W008",
    path: "src/lib/tools/domains/leases.ts",
    requiredPattern: /rowAllowedInAgentWorkspace|propertyInAgentWorkspace/,
  },
  {
    finding: "W008",
    path: "src/lib/tools/domains/promotions.ts",
    requiredPattern: /loadAllManagerRows/,
  },
  {
    finding: "W010",
    path: "src/lib/channel-calendar/bookings.server.ts",
    requiredPattern: /activeWorkspacePropertyScope/,
  },
  {
    finding: "W011",
    path: "src/lib/manual-planned-tour.server.ts",
    requiredPattern: /assertPropertyInActiveWorkspace/,
  },
  {
    finding: "W015",
    path: "src/app/api/manager-bills/[id]/route.ts",
    requiredPattern: /voidManagerBill/,
  },
];

describe("workspace-isolation security fixes stay wired (2026-09-27 pass)", () => {
  it.each(FIXED_SURFACES)("$finding: $path still calls its scope primitive", ({ path, requiredPattern }) => {
    const source = code(path);
    expect(source).toMatch(requiredPattern);
  });
});
