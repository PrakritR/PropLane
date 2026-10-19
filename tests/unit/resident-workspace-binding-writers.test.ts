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
    // scripts/one-number/e2e/fixtures.mjs: the dev-only texting e2e harness (refuses any project but dev) seeds signed-in residents.
    expect(touching).toEqual(["scripts/lib/account-deletion.mjs", "scripts/one-number/e2e/fixtures.mjs", "src/lib/auth/account-purge-manifest.ts", "src/lib/auth/resident-account-deletion.ts", "src/lib/auth/resident-workspace-binding.ts"]);
  });

  it("recordResidentWorkspaceBinding has one caller: a resident's own non-draft submit, shared by /api/manager-applications and Quick apply", () => {
    const WRITER = "src/lib/rental-application/signed-in-application-write.server.ts";
    const callers = sources
      .filter((file) => !rel(file).endsWith("resident-workspace-binding.ts"))
      .filter((file) => fs.readFileSync(file, "utf8").includes("recordResidentWorkspaceBinding("))
      .map(rel);
    expect(callers).toEqual([WRITER]);

    const writer = fs.readFileSync(path.join(ROOT, WRITER), "utf8");
    expect(writer.match(/recordResidentWorkspaceBinding\(/g)).toHaveLength(1);
    const call = writer.indexOf("recordResidentWorkspaceBinding(db");
    expect(call).toBeGreaterThan(-1);
    // Gated on the resident's own write AND on a real submit: starting a draft binds nothing.
    const gate = writer.lastIndexOf("if (residentSelfWrite && !isDraftShapedApplicationRow(row)) {", call);
    expect(gate).toBeGreaterThan(-1);
    // Written only after the row itself is stored, so the proof never outlives a failed save.
    const save = writer.lastIndexOf("row = await persistNormalizedRow(", call);
    expect(save).toBeGreaterThan(-1);
    expect(save).toBeLessThan(gate);
    // The id is the session's, never the body's.
    expect(writer.slice(call, call + 200)).toContain("residentUserId: user.id");
    // The writer's ownership check runs on the authenticated email before anything is stored.
    const prepare = writer.slice(writer.indexOf("export async function prepareResidentSelfWrite"));
    expect(prepare).toContain("rowEmail !== email");
    expect(prepare).toContain("You can only update your own application.");

    // `residentSelfWrite` is set in exactly one place in the route: the branch that runs only for the
    // signed-in user's own email, and that branch goes through the shared preparer.
    const route = fs.readFileSync(path.join(ROOT, "src/app/api/manager-applications/route.ts"), "utf8");
    expect(route.match(/residentSelfWrite = true;/g)).toHaveLength(1);
    const branchStart = route.indexOf("if (role === \"resident\" || selfApplicationWrite) {");
    expect(branchStart).toBeGreaterThan(-1);
    const branch = route.slice(branchStart, route.indexOf("} else {", branchStart));
    expect(branch).toContain("residentSelfWrite = true;");
    expect(branch).toContain("prepareResidentSelfWrite(db, user");
  });
});
