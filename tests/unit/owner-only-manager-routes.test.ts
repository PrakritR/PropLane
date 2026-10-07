import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// An owner-only account holds the manager role row only to host /portal/owner.
// A manager-surface route must refuse it (403). Almost all of them inherit that
// from their auth helper, so the enumeration below walks `src/app/api/**` and
// fails a route that authenticates through a manager helper which is NOT
// owner-aware unless the route refuses on its own or is listed as exempt.
const read = (p: string) => readFileSync(p, "utf8");

const API_ROOT = path.resolve(__dirname, "../../src/app/api");

/** Every manager auth entry point a route may use, and whether IT refuses an owner-only account. */
const MANAGER_AUTH_HELPERS: { name: string; ownerAware: boolean; provenBy: string }[] = [
  { name: "requireManagerRouteUser", ownerAware: true, provenBy: "src/lib/manager-route-guard.server.ts" },
  { name: "getReportsAuthContext", ownerAware: true, provenBy: "src/lib/reports/auth.ts" },
  { name: "resolveAgentContext", ownerAware: true, provenBy: "src/lib/tools/context.ts" },
  { name: "resolvePortalInboxThreadScope", ownerAware: true, provenBy: "src/lib/portal-inbox-thread-scope.ts" },
];

/** Routes that authenticate some other way and were reviewed, with the reason. */
const EXEMPT: Record<string, string> = {
  "pro/account-links/redeem/route.ts": "joining a team is how an owner-only account stops being one",
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
      expect(read(helper.provenBy), helper.name).toMatch(/ownerAccessStateFor|refuseOwnerOnly/);
    }
  });

  it("every API route using a manager auth helper refuses, inherits a refusal, or is listed exempt", () => {
    const files = routeFiles(API_ROOT);
    expect(files.length).toBeGreaterThan(300);
    const gaps: string[] = [];
    for (const file of files) {
      const rel = path.relative(API_ROOT, file).split(path.sep).join("/");
      const src = readFileSync(file, "utf8");
      const used = MANAGER_AUTH_HELPERS.filter((helper) => src.includes(`${helper.name}(`));
      if (used.length === 0) continue;
      if (used.some((helper) => helper.ownerAware)) continue;
      if (src.includes("refuseOwnerOnly") || src.includes("ownerAccessStateFor")) continue;
      if (rel in EXEMPT) continue;
      gaps.push(rel);
    }
    expect(
      gaps,
      "Call refuseOwnerOnly() (src/lib/property-owner/route-auth.server.ts), authenticate through an owner-aware helper, or review the route and list it in EXEMPT with a reason.",
    ).toEqual([]);
  });

  it("an exemption is not stale", () => {
    for (const rel of Object.keys(EXEMPT)) {
      expect(() => statSync(path.join(API_ROOT, rel)), rel).not.toThrow();
    }
  });

  it("/api/agent/chat: every verb denies through the owner-aware path", () => {
    const src = read("src/app/api/agent/chat/route.ts");
    expect(src).toContain("refuseOwnerOnly");
    expect(src.match(/if \(!ctx\) return unauthorizedOrOwnerOnly\(\)/g)?.length).toBe(3);
    expect(read("src/lib/tools/context.ts")).toMatch(/ownerAccessStateFor\(db, user\.id\)\)\.ownerOnly\) return null/);
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
    expect(read("src/lib/portal-inbox-thread-scope.ts")).toMatch(/scope === MANAGER_INBOX_SCOPE && \(await ownerAccessStateFor/);
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
