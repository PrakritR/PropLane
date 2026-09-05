import { describe, expect, it } from "vitest";
import {
  coManagerModuleAllowed,
  normalizePropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";

describe("bankAccount co-manager permission", () => {
  it("is included in the permission catalog", () => {
    const perms = normalizePropertyCoManagerPermissions({ bankAccount: { edit: true } }, ["prop-1"]);
    expect(perms["prop-1"]?.bankAccount).toEqual({ edit: true });
  });

  it("gates bank account edits per property", () => {
    const perms = normalizePropertyCoManagerPermissions(
      {
        "prop-1": { bankAccount: { edit: true } },
        "prop-2": {},
      },
      ["prop-1", "prop-2"],
    );
    expect(coManagerModuleAllowed(perms, "prop-1", "bankAccount", "edit")).toBe(true);
    expect(coManagerModuleAllowed(perms, "prop-2", "bankAccount", "edit")).toBe(false);
  });
});
