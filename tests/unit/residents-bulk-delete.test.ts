import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Managers must be able to delete residents from the list, not only from inside
 * Edit resident. The reason Delete was kept off this bar is real — a bar names
 * nobody, so a row ticked by accident could be destroyed without ever being read
 * back — so the control is only allowed to exist alongside a confirmation that
 * lists every resident it is about to destroy.
 */
const SOURCE = readFileSync(`${process.cwd()}/src/components/portal/pro-residents.tsx`, "utf8");

describe("residents list — bulk delete", () => {
  it("offers Delete on the bulk bar", () => {
    expect(SOURCE).toContain('data-attr="residents-bulk-delete"');
    // Disabled with an empty selection, so the bar cannot fire on nothing.
    expect(SOURCE).toContain("disabled={listSelectedResidents.length === 0}");
  });

  it("names every selected resident in the confirmation before it runs", () => {
    expect(SOURCE).toContain("<ConfirmDeleteModal");
    expect(SOURCE).toContain('dataAttr="residents-bulk-delete-confirm"');
    // The description maps over the selection — a count alone would not tell the
    // manager who is going.
    expect(SOURCE).toMatch(/listSelectedResidents\.map\(\(resident\)/);
  });

  it("deletes through the same path Edit resident uses, one at a time", () => {
    // `executeResidentDelete` is what purges the server record plus the local
    // application, lease, charge, service and inbox rows; a second implementation
    // would drift from it. Serial, because they all rewrite the same stores.
    expect(SOURCE).toMatch(/for \(const resident of listSelectedResidents\) \{\s*\n\s*if \(await executeResidentDelete\(resident\)\)/);
  });

  it("clears the selection and leaves a detail route it just destroyed", () => {
    expect(SOURCE).toMatch(/clearSelection\(\);\s*\n\s*if \(activeResidentId && listSelectedResidents\.some/);
  });
});

describe("residents — a record only this browser knows about", () => {
  /**
   * The delete route refuses an unknown record exactly as it refuses someone
   * else's, because saying which would tell any manager whether an address has
   * an account. That left a resident which never reached the server stuck in the
   * list, refusing every Delete with "not in your portfolio".
   */
  it("clears it locally only after the manager's own server list disagrees too", () => {
    expect(SOURCE).toContain("async function residentIsLocalOnly");
    expect(SOURCE).toContain("if (!(await residentIsLocalOnly(selectedResident)))");
    // The refusal still stands for anything the server does know about.
    expect(SOURCE).toContain("showToast(serverDeleteError);");
  });

  it("treats an unreadable server list as no permission at all", () => {
    // Both the non-ok branch and the throw answer false, so an unreachable
    // server can never be mistaken for "the record does not exist".
    expect(SOURCE).toContain("if (!res.ok) return false;");
    expect(SOURCE).toContain('const res = await fetch("/api/manager-applications", { credentials: "include" });');
  });

  it("says so when a delete run removed nothing", () => {
    expect(SOURCE).toContain("} else if (failed.length > 0) {");
    expect(SOURCE).toContain("could not be deleted.");
  });
});
