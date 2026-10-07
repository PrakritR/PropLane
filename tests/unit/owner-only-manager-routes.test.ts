import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// An owner-only account holds the manager role row only to host /portal/owner.
// A manager-surface route must refuse it (403). Most inherit that from their
// auth helper; the rest check a manager role themselves, which is exactly the
// shape `/api/portal-vendors` had when it leaked shared vendor contact rows.
// The enumeration below walks `src/app/api/**` and fails BOTH shapes: a route
// on a helper that is not owner-aware, and a route that authenticates itself
// and branches on a manager role — unless it refuses or is listed in EXEMPT
// with the reviewed reason it cannot leak.
const read = (p: string) => readFileSync(p, "utf8");

const API_ROOT = path.resolve(__dirname, "../../src/app/api");

/** Every manager auth entry point a route may use, and whether IT refuses an owner-only account. */
const MANAGER_AUTH_HELPERS: { name: string; ownerAware: boolean; provenBy: string }[] = [
  { name: "requireManagerRouteUser", ownerAware: true, provenBy: "src/lib/manager-route-guard.server.ts" },
  { name: "getReportsAuthContext", ownerAware: true, provenBy: "src/lib/reports/auth.ts" },
  { name: "resolveAgentContext", ownerAware: true, provenBy: "src/lib/tools/context.ts" },
  { name: "resolvePortalInboxThreadScope", ownerAware: true, provenBy: "src/lib/portal-inbox-thread-scope.ts" },
];

/** A route deciding a manager role for itself, rather than through a helper above. */
const OWN_MANAGER_ROLE_CHECK =
  /(role\s*(!==|===)\s*"(manager|pro)")|(hasRole\((?:access|ctx|portal)[^)]*,\s*"manager"\))|(\["manager",\s*"pro"[^\]]*\]\.includes)|(userIsPropertyPortalManager\()/;

/** A route refuses on its own when it reaches the owner membership by any of these. */
const OWN_REFUSAL = ["refuseOwnerOnly", "ownerAccessStateFor", "withholdManagerSurface"];

const REASONS = {
  ownAccountOnly:
    "every read and write is pinned to the caller's own manager_user_id, and an owner-only account owns no house, resident, lease, charge or vendor for it to answer with",
  notManagerSurface:
    "not a manager surface: the caller is a resident, vendor, public token or admin, and the manager role appears only as a branch inside that flow",
  ownerUpgradePath: "this IS how an account stops being owner-only, so refusing it would strip the way out",
} as const;

/** Routes that authenticate themselves (or on a non-owner-aware helper) and were reviewed. */
const EXEMPT: Record<string, keyof typeof REASONS> = {
  "pro/account-links/redeem/route.ts": "ownerUpgradePath",
  "admin/portal-users/route.ts": "notManagerSurface",
  "linked-form-requests/[id]/route.ts": "notManagerSurface",
  "public/cosigner-submissions/route.ts": "notManagerSurface",
  "manager-applications/route.ts": "ownAccountOnly",
  "manager/amend-lease/route.ts": "ownAccountOnly",
  "manager/app-download-email/route.ts": "ownAccountOnly",
  "manager/resident-account-emails/route.ts": "ownAccountOnly",
  "manager/resident-portal-status/route.ts": "ownAccountOnly",
  "manager/sms-contacts/route.ts": "ownAccountOnly",
  "manager/sms-conversations/[id]/route.ts": "ownAccountOnly",
  "manager/sms-conversations/houses/route.ts": "ownAccountOnly",
  "manager/sms-conversations/route.ts": "ownAccountOnly",
  "manager/sms-messages/route.ts": "ownAccountOnly",
  "manager/tour-follow-ups/route.ts": "ownAccountOnly",
  "manager/update-lease-packet/route.ts": "ownAccountOnly",
  "manager/vendor-payouts/route.ts": "ownAccountOnly",
  "manager/vendor-preferences/route.ts": "ownAccountOnly",
  "manager/vendor-text-consent/route.ts": "ownAccountOnly",
  "portal-household-charges/route.ts": "ownAccountOnly",
  "portal-lease-pipeline/route.ts": "ownAccountOnly",
  "portal-promotions/route.ts": "ownAccountOnly",
  "portal-schedule-suggest/route.ts": "ownAccountOnly",
  "portal-vendors/[vendorId]/summary/route.ts": "ownAccountOnly",
  "portal/applicant-ids/route.ts": "ownAccountOnly",
  "portal/application-photos/route.ts": "ownAccountOnly",
  "portal/delete-resident-access/route.ts": "ownAccountOnly",
  "portal/dispatch-proposals/route.ts": "ownAccountOnly",
  "portal/purge-orphaned-records/route.ts": "ownAccountOnly",
  "portal/send-application-completion-reminder/route.ts": "ownAccountOnly",
  "portal/send-inbox-message/route.ts": "ownAccountOnly",
  "portal/send-lead-invite/route.ts": "ownAccountOnly",
  "portal/send-manager-application-started/route.ts": "ownAccountOnly",
  "portal/send-task-reminder/route.ts": "ownAccountOnly",
  "portal/send-vendor-invite/route.ts": "ownAccountOnly",
  "portal/send-vendor-visit-email/route.ts": "ownAccountOnly",
  "portal/tours-export/route.ts": "ownAccountOnly",
  "portal/vendor-invite-draft/route.ts": "ownAccountOnly",
  "portal/vendor-removal-draft/route.ts": "ownAccountOnly",
  "pro/purge-orphaned-co-manager-links/route.ts": "ownAccountOnly",
  "vendor/availability/route.ts": "ownAccountOnly",
};

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (name === "route.ts" || name === "route.tsx") out.push(full);
  }
  return out;
}

describe("manager routes refuse an owner-only account", () => {
  it("the shared helper answers 403, and 503 when the membership cannot be read", () => {
    const src = read("src/lib/property-owner/route-auth.server.ts");
    expect(src).toMatch(/export async function refuseOwnerOnly[\s\S]*status: 403/);
    expect(src).toMatch(/export async function refuseOwnerOnly[\s\S]*status: 503/);
  });

  it("every manager auth helper this enumeration trusts still refuses an owner-only account", () => {
    for (const helper of MANAGER_AUTH_HELPERS.filter((h) => h.ownerAware)) {
      expect(read(helper.provenBy), helper.name).toMatch(/ownerAccessStateFor|refuseOwnerOnly|withholdManagerSurface/);
    }
  });

  it("every manager-surface route refuses, inherits a refusal, or is listed exempt", () => {
    const files = routeFiles(API_ROOT);
    expect(files.length).toBeGreaterThan(300);
    const gaps: string[] = [];
    for (const file of files) {
      const rel = path.relative(API_ROOT, file).split(path.sep).join("/");
      const src = readFileSync(file, "utf8");
      if (OWN_REFUSAL.some((name) => src.includes(name))) continue;
      const used = MANAGER_AUTH_HELPERS.filter((helper) => src.includes(`${helper.name}(`));
      if (used.some((helper) => helper.ownerAware)) continue;
      // Either shape counts: a non-owner-aware helper, or its own manager-role check.
      const managerSurface = used.length > 0 || OWN_MANAGER_ROLE_CHECK.test(src);
      if (!managerSurface) continue;
      if (rel in EXEMPT) continue;
      gaps.push(rel);
    }
    expect(
      gaps,
      "Call refuseOwnerOnly() (src/lib/property-owner/route-auth.server.ts), authenticate through an owner-aware helper, or review the route and list it in EXEMPT with its reason.",
    ).toEqual([]);
  });

  it("the enumeration really sees a route that checks a manager role itself", () => {
    // A real one of that shape, and the two ways it is written.
    const sample = read("src/app/api/portal/send-inbox-message/route.ts");
    expect(sample).not.toContain("requireManagerRouteUser(");
    expect(OWN_MANAGER_ROLE_CHECK.test(sample)).toBe(true);
    expect(OWN_MANAGER_ROLE_CHECK.test('if (role !== "manager") return;')).toBe(true);
    expect(OWN_MANAGER_ROLE_CHECK.test('if (!hasRole(ctx, "manager")) return;')).toBe(true);
    // ...and does not fire on a route that never names the role.
    expect(OWN_MANAGER_ROLE_CHECK.test('const role = "x";')).toBe(false);
    // A route authorized by row ownership instead of a role is not this class:
    // it is pinned to the charge's own manager, which an owner never is.
    expect(OWN_MANAGER_ROLE_CHECK.test(read("src/app/api/portal/take-payment/route.ts"))).toBe(false);
  });

  it("an exemption is not stale, and still needs its reason", () => {
    for (const [rel, reason] of Object.entries(EXEMPT)) {
      expect(() => statSync(path.join(API_ROOT, rel)), rel).not.toThrow();
      expect(REASONS[reason], rel).toBeTruthy();
    }
  });

  it("the routes that read other accounts' vendor rows refuse, like /api/portal-vendors", () => {
    for (const rel of [
      "manager/vendor-directory/route.ts",
      "manager/vendor-directory/add/route.ts",
      "portal-vendors/online-search/route.ts",
      "pro/lookup-axis-id/route.ts",
    ]) {
      expect(read(path.join(API_ROOT, rel)), rel).toContain("refuseOwnerOnly");
    }
  });

  it("/api/agent/chat: every verb denies through the owner-aware path", () => {
    const src = read("src/app/api/agent/chat/route.ts");
    expect(src).toContain("refuseOwnerOnly");
    expect(src.match(/if \(!ctx\) return unauthorizedOrOwnerOnly\(\)/g)?.length).toBe(3);
    expect(read("src/lib/tools/context.ts")).toMatch(/withholdManagerSurface\(db, user\.id\)\)\) return null/);
  });

  it("/api/workspaces POST refuses before reading the body", () => {
    const src = read("src/app/api/workspaces/route.ts");
    const post = src.slice(src.indexOf("export async function POST"));
    expect(post.indexOf("refuseOwnerOnly")).toBeGreaterThan(-1);
    expect(post.indexOf("refuseOwnerOnly")).toBeLessThan(post.indexOf("request.json()"));
  });

  it("/api/pro/account-links POST and PATCH refuse", () => {
    const post = read("src/app/api/pro/account-links/route.ts");
    expect(post.slice(post.indexOf("export async function POST"))).toContain("refuseOwnerOnly");
    expect(read("src/app/api/pro/account-links/[inviteId]/route.ts")).toContain("refuseOwnerOnly");
  });

  it("the manager inbox scope refuses in GET and POST, and the resolver nulls it for draft routes", () => {
    const src = read("src/app/api/portal-inbox-threads/route.ts");
    expect(src.match(/refuseOwnerOnly\(ctx\.db, ctx\.user\.id\)/g)?.length).toBe(2);
    expect(read("src/lib/portal-inbox-thread-scope.ts")).toMatch(/scope === MANAGER_INBOX_SCOPE && \(await withholdManagerSurface/);
  });

  it("the account-links redeem route is the one conscious exemption (joining a team is how an owner upgrades)", () => {
    expect(read("src/app/api/pro/account-links/redeem/route.ts")).not.toContain("refuseOwnerOnly");
  });
});

describe("Transfer ownership is never offered for a Property owner", () => {
  it("the manager UI hides it and both transfer libs refuse it", () => {
    const ui = read("src/components/portal/pro-account-links-panel.tsx");
    expect(ui).toContain('entry.invite.teamRole === "property_owner") return null');
    expect(ui).toContain('member.role === "property_owner") return null');
    expect(read("src/lib/workspace-ownership-transfer.ts")).toContain("property_owner");
    expect(read("src/lib/property-ownership-transfer.ts")).toContain("property_owner");
  });
});
