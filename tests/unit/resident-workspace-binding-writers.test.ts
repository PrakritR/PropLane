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
    expect(touching).toEqual(["scripts/lib/account-deletion.mjs", "src/lib/auth/account-purge-manifest.ts", "src/lib/auth/resident-account-deletion.ts", "src/lib/auth/resident-workspace-binding.ts"]);
  });

  it("recordResidentWorkspaceBinding has one caller: a resident's own non-draft submit on /api/manager-applications", () => {
    const callers = sources
      .filter((file) => !rel(file).endsWith("resident-workspace-binding.ts"))
      .filter((file) => fs.readFileSync(file, "utf8").includes("recordResidentWorkspaceBinding("))
      .map(rel);
    expect(callers).toEqual(["src/app/api/manager-applications/route.ts"]);

    const route = fs.readFileSync(path.join(ROOT, "src/app/api/manager-applications/route.ts"), "utf8");
    expect(route.match(/recordResidentWorkspaceBinding\(/g)).toHaveLength(1);
    const call = route.indexOf("recordResidentWorkspaceBinding(db");
    expect(call).toBeGreaterThan(-1);
    // Gated on the resident's own write AND on a real submit: starting a draft binds nothing.
    const gate = route.lastIndexOf("if (residentSelfWrite && !isDraftShapedApplicationRow(row)) {", call);
    expect(gate).toBeGreaterThan(-1);
    // Written only after the row itself is stored, so the proof never outlives a failed save.
    const save = [...route.matchAll(/row = await persistNormalizedRow\(\s*db, authorizedWriteRecord\?\.id \?\? row\.id, row, authorizedWriteRecord,/g)]
      .map((match) => match.index)
      .filter((index) => index < call)
      .at(-1) ?? -1;
    expect(save).toBeGreaterThan(-1);
    expect(save).toBeLessThan(gate);
    // The id is the session's, never the body's.
    expect(route.slice(call, call + 200)).toContain("residentUserId: user.id");
    // `residentSelfWrite` is set in exactly one place: the branch that runs only for the
    // signed-in user's own email.
    expect(route.match(/residentSelfWrite = true;/g)).toHaveLength(1);
    const branchStart = route.indexOf("if (role === \"resident\" || selfApplicationWrite) {");
    expect(branchStart).toBeGreaterThan(-1);
    const branch = route.slice(branchStart, route.indexOf("const priorLoad = await loadStoredApplicationRecord", branchStart));
    expect(branch).toContain("residentSelfWrite = true;");
    expect(branch).toContain("rowEmail !== email");
    expect(branch).toContain("You can only update your own application.");
  });
});
