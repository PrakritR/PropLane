import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `resident_workspace_bindings` is the proof that lets a manager's "Delete resident" also delete the
 * resident's login. It must be writable only from the resident's own authenticated session. This
 * walks the source and fails if any other code can write it.
 */
const ROOT = path.resolve(__dirname, "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (file: string) => path.relative(ROOT, file);

describe("resident_workspace_bindings writers", () => {
  const sources = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts"))];

  it("only the binding module touches the table", () => {
    const touching = sources.filter((file) => fs.readFileSync(file, "utf8").includes("resident_workspace_bindings")).map(rel).sort();
    expect(touching).toEqual(["src/lib/auth/account-purge-manifest.ts", "src/lib/auth/resident-account-deletion.ts", "src/lib/auth/resident-workspace-binding.ts"]);
  });

  it("recordResidentWorkspaceBinding has one caller: the resident self-write branch of /api/manager-applications", () => {
    const callers = sources
      .filter((file) => !rel(file).endsWith("resident-workspace-binding.ts"))
      .filter((file) => fs.readFileSync(file, "utf8").includes("recordResidentWorkspaceBinding("))
      .map(rel);
    expect(callers).toEqual(["src/app/api/manager-applications/route.ts"]);

    const route = fs.readFileSync(path.join(ROOT, "src/app/api/manager-applications/route.ts"), "utf8");
    expect(route.match(/recordResidentWorkspaceBinding\(/g)).toHaveLength(1);
    const call = route.indexOf("recordResidentWorkspaceBinding(db");
    const branchStart = route.indexOf("if (role === \"resident\" || selfApplicationWrite) {");
    // The manager branch begins after the resident branch closes; the call must sit inside the first.
    const managerBranch = route.indexOf("resolveApplicationWriteOwner(db, user.id, row", call);
    expect(branchStart).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(branchStart);
    expect(call).toBeLessThan(managerBranch);
    // The id is the session's, never the body's.
    expect(route.slice(call, call + 200)).toContain("residentUserId: user.id");
    // That branch only runs for the signed-in user's own email.
    const branch = route.slice(branchStart, call);
    expect(branch).toContain("rowEmail !== email");
    expect(branch).toContain("You can only update your own application.");
  });
});
