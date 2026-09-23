import { describe, expect, it } from "vitest";
import {
  AUTH_PORTAL_PICKER_OPTIONS,
  filterAddablePortalPickerOptions,
} from "@/lib/auth/auth-portal-picker-options";
import type { AuthRole } from "@/components/auth/portal-switcher";

describe("filterAddablePortalPickerOptions (add-portal mode)", () => {
  it("offers every picker portal when the account holds none", () => {
    expect(filterAddablePortalPickerOptions([]).map((o) => o.id)).toEqual(
      AUTH_PORTAL_PICKER_OPTIONS.map((o) => o.id),
    );
  });

  it("hides portals the account already holds (membership), including admin-only noise", () => {
    const held: AuthRole[] = ["resident", "admin"];
    expect(filterAddablePortalPickerOptions(held).map((o) => o.id)).toEqual(["manager", "vendor"]);
  });

  it("hides manager when membership includes manager even if a caller once confused reachable with held", () => {
    // Regression: portal-roles used to return reachable-only roles, so a held
    // but previously-blocked manager never appeared in `roles` and the add UI
    // kept offering "Set up as a property manager".
    expect(filterAddablePortalPickerOptions(["manager", "resident"]).map((o) => o.id)).toEqual([
      "vendor",
    ]);
  });

  it("shows empty when every picker portal is already held", () => {
    expect(filterAddablePortalPickerOptions(["manager", "resident", "vendor"])).toEqual([]);
  });
});
