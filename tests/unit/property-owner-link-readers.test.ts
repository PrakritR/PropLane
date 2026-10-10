/**
 * Every reader of `account_link_invites` either filters Property owner rows out
 * (`withoutOwnerLinks`) or is on this list with the reason it cannot leak. A new
 * reader that does neither fails here, because an accepted owner row looks
 * exactly like a teammate row to code that only checks `status = 'accepted'`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../../src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** Reads that cannot hand an owner teammate-style reach, and why. */
const REVIEWED: Record<string, string> = {
  // Membership management: these ARE the owner-aware code (or act on rows they were handed).
  "app/api/pro/account-links/route.ts": "membership CRUD; owner role gets no members right and stores owner keys only",
  "app/api/pro/account-links/[inviteId]/route.ts": "membership CRUD; role writes strip foreign keys",
  "app/api/pro/account-links/[inviteId]/link/route.ts": "membership CRUD",
  "app/api/pro/account-links/redeem/route.ts": "redeem (owner-only provisioning lives in invite-links.server)",
  "lib/invite-links/invite-links.server.ts": "mint/redeem; owner role is handled explicitly",
  "lib/co-manager-open-invite.server.ts": "open-invite redeem",
  "lib/workspaces/membership.server.ts": "standing: an owner row resolves to rights of none",
  "lib/workspaces/server.ts": "workspace switcher: owner rows add no houses (no module key) and carry no rights",
  "lib/auth/resident-account-deletion.ts": "existence check only: ANY invite row, owner rows included, keeps the resident's login",
  "lib/auth/purge-orphaned-co-manager-links.ts": "cleanup",
  "lib/auth/clear-property-housing-access.ts": "cleanup",
  "lib/co-manager-plan-reconcile.server.ts": "plan downgrade disconnects links",
  "lib/property-ownership-transfer.ts": "ownership transfer rewrites links",
  "lib/workspace-ownership-transfer.ts": "ownership transfer rewrites links",
  // Reads gated by a module permission an owner row never holds.
  "app/api/property-records/route.ts": "adds linked houses only where the properties module is granted",
  "lib/team-comms.server.ts": "gated by the inbox module",
  "lib/tour-host-enumeration.server.ts": "gated by calendar/applications edit",
  "lib/workspace-connect/resolve.server.ts": "gated by bankAccount",
  "lib/test-workspaces/schedule-route.server.ts": "gated by the calendar grant",
  // Inviter-side or explicitly checked.
  "lib/manager-property-share-access.ts": "inviter side: the viewer is the inviter",
  "app/api/manager/work-contact/route.ts": "checks team_role in the route",
  // Admin-only, read-only: the account record lists every accepted link on purpose.
  "lib/admin/admin-account-detail.server.ts": "admin record shows all accepted links, owner rows included, grants nothing",
  // Owner readers.
  "lib/property-owner/access.server.ts": "the owner readers",
};

describe("account_link_invites readers", () => {
  const readers = walk(SRC)
    .filter((file) => /from\("account_link_invites"\)/.test(readFileSync(file, "utf8")))
    .map((file) => ({ rel: path.relative(SRC, file).split(path.sep).join("/"), text: readFileSync(file, "utf8") }));

  it("finds the readers", () => {
    expect(readers.length).toBeGreaterThan(30);
  });

  it("each one filters owner rows out or is reviewed", () => {
    const unreviewed = readers.filter((r) => !r.text.includes("withoutOwnerLinks") && !(r.rel in REVIEWED)).map((r) => r.rel);
    expect(unreviewed, `Filter Property owner rows with withoutOwnerLinks() (src/lib/co-manager-team-roles.ts), or review the reader and list it with a reason.`).toEqual([]);
  });

  it("a reviewed entry is not stale", () => {
    const present = new Set(readers.map((r) => r.rel));
    const stale = Object.keys(REVIEWED).filter((rel) => !present.has(rel));
    expect(stale).toEqual([]);
  });

  it("a filtered reader also selects team_role (the filter needs the column)", () => {
    for (const r of readers.filter((x) => x.text.includes("withoutOwnerLinks("))) {
      expect(r.text.includes("team_role") || r.text.includes("INVITE_PERMISSION_COLUMNS"), r.rel).toBe(true);
    }
  });
});
