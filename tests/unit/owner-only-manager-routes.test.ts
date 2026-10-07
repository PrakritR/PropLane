import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// An owner-only account holds the manager role row only to host /portal/owner.
// Every manager-surface route must either refuse it (403) or be listed here as
// a conscious exemption. A new manager route that does neither is a leak.
const read = (p: string) => readFileSync(p, "utf8");

describe("manager routes refuse an owner-only account", () => {
  it("the shared helper answers 403", () => {
    const src = read("src/lib/property-owner/route-auth.server.ts");
    expect(src).toMatch(/export async function refuseOwnerOnly[\s\S]*status: 403/);
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
