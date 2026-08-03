import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Legacy-role drift guard.
 *
 * `profiles.role` records only the role an account was CREATED as, so a
 * resident who later becomes a manager reads back as `"manager"` forever. A
 * route that decides resident access or resident row scoping from that column
 * either 403s a real resident or — worse — hands them the manager branch and
 * renders another person's rows in the resident portal.
 *
 * `src/lib/auth/resident-role-access.ts` is the one place that answers "is this
 * caller a resident" (`authorizeResidentRole`) and "which portal is this
 * request acting in" (`resolveResidentScopedActorRole`). This test fails when a
 * route branches on `"resident"` off the legacy column without consulting
 * `profile_roles` — through that helper or directly.
 *
 * Static sibling of `role-grant-surface.test.ts`, which guards the DB side of
 * the same trust boundary.
 */

const API_DIR = join(process.cwd(), "src", "app", "api");

/**
 * Routes still deciding resident access off `profiles.role`. Every entry is a
 * KNOWN, deliberately deferred violation — not an exemption for new code. The
 * list may only shrink.
 */
const DEFERRED_ROUTES: Record<string, string> = {
  // axis-dual-portal-role-resolution: also changes MANAGER behavior (the
  // manager applications list self-scopes off the same read), so it needs
  // manager-side verification before it moves onto the shared predicate.
  "manager-applications/route.ts": "axis-dual-portal-role-resolution",
  // axis-dual-portal-role-resolution: the approve/deny path branches on the
  // requestor role three times and drives resident provisioning.
  "portal/resident-approval/route.ts": "axis-dual-portal-role-resolution",
  // axis-dual-portal-role-resolution: dual-audience like portal-work-orders —
  // the resident branch scopes by email, the other branch is the manager's
  // whole pipeline.
  "portal-lease-pipeline/route.ts": "axis-dual-portal-role-resolution",
  // axis-dual-portal-role-resolution: resolves an applicant-vs-manager session
  // kind for photo ownership; the manager branch wins for a multi-role account.
  "portal/application-photos/route.ts": "axis-dual-portal-role-resolution",
  // Not a caller-authorization read: this classifies RECIPIENT profiles to pick
  // an inbox scope. It is listed so the detector stays strict rather than being
  // loosened to let recipient classification through everywhere.
  "portal/send-inbox-message/route.ts": "recipient classification, not the caller",
};

/**
 * Resident-scoped routes already migrated onto the shared predicate. Pinned so
 * dropping the import — which silently restores the legacy read — fails here
 * even when the route no longer spells out a `"resident"` comparison.
 */
const MIGRATED_ROUTES = [
  "resident/extend-lease/route.ts",
  "resident/check-move-out-availability/route.ts",
  "resident/sms-conversations/route.ts",
  "portal/resident-report-manual-payment/route.ts",
  "portal/resident-check-manual-payment/route.ts",
  "portal/work-orders/send-reminder/route.ts",
  "portal-service-requests/route.ts",
  "portal-work-orders/route.ts",
];

const SHARED_HELPER = "@/lib/auth/resident-role-access";

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

/** Repo-relative, POSIX-style path under src/app/api. */
function apiPath(file: string): string {
  return relative(API_DIR, file).split(sep).join("/");
}

/** Strips comments so prose about `profiles.role` never registers as code. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const READS_LEGACY_ROLE = /from\(\s*"profiles"\s*\)/;
const SELECTS_ROLE = /select\(\s*"[^"]*\brole\b[^"]*"/;
const BRANCHES_ON_RESIDENT = /[!=]==\s*"resident"/;
const CONSULTS_PROFILE_ROLES = /profile_roles|resident-role-access/;

function violates(source: string): boolean {
  return (
    READS_LEGACY_ROLE.test(source) &&
    SELECTS_ROLE.test(source) &&
    BRANCHES_ON_RESIDENT.test(source) &&
    !CONSULTS_PROFILE_ROLES.test(source)
  );
}

const ROUTES = routeFiles(API_DIR).map((file) => ({ path: apiPath(file), source: code(file) }));

describe("resident authorization reads profile_roles, never legacy profiles.role", () => {
  it("finds routes to scan", () => {
    expect(ROUTES.length).toBeGreaterThan(50);
  });

  it("has no route branching on \"resident\" off the legacy column", () => {
    const offenders = ROUTES.filter((r) => violates(r.source) && !(r.path in DEFERRED_ROUTES)).map(
      (r) => r.path,
    );
    expect(offenders).toEqual([]);
  });

  it("keeps every deferred route genuinely deferred (the allowlist may only shrink)", () => {
    const stale = Object.keys(DEFERRED_ROUTES).filter((path) => {
      const route = ROUTES.find((r) => r.path === path);
      return !route || !violates(route.source);
    });
    expect(stale).toEqual([]);
  });

  it("keeps every migrated resident-scoped route on the shared predicate", () => {
    const dropped = MIGRATED_ROUTES.filter((path) => {
      const route = ROUTES.find((r) => r.path === path);
      return !route || !route.source.includes(SHARED_HELPER);
    });
    expect(dropped).toEqual([]);
  });
});
