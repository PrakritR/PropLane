import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { INVITE_PERMISSION_COLUMNS } from "@/lib/account-link-invite-row";

/**
 * Every reader that turns an `account_link_invites` row into a per-house
 * permission map must select `house_scope` and `team_role`. On an "all houses"
 * row the database appends houses as they join the workspace without a
 * per-house map entry; only those two columns let
 * `readPropertyPermissionsFromRow` fill the gap from the role. A reader that
 * drops them sees an empty entry — which some gates read as full access and
 * others as none.
 */

const SRC_DIR = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function selectStrings(source: string): string[] {
  const out: string[] = [];
  const re = /\.select\(\s*(?:"([^"]*)"|`([^`]*)`)\s*(?:,[^)]*)?\)/g;
  for (let match = re.exec(source); match; match = re.exec(source)) {
    out.push(match[1] ?? match[2] ?? "");
  }
  return out;
}

describe("account_link_invites permission readers", () => {
  it("INVITE_PERMISSION_COLUMNS names both scope columns", () => {
    expect(INVITE_PERMISSION_COLUMNS).toContain("house_scope");
    expect(INVITE_PERMISSION_COLUMNS).toContain("team_role");
  });

  it("every select that feeds a per-house permission map carries house_scope and team_role", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("account_link_invites")) continue;
      if (!/(?:normalizePropertyCoManagerPermissions|readPropertyPermissionsFromRow)\(/.test(source)) continue;
      for (const select of selectStrings(source)) {
        if (!select.includes("property_co_manager_permissions")) continue;
        if (select.includes("INVITE_PERMISSION_COLUMNS")) continue;
        if (select.includes("house_scope") && select.includes("team_role")) continue;
        offenders.push(`${relative(process.cwd(), file)}: select("${select}")`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
