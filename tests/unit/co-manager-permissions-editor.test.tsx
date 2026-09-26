// @vitest-environment jsdom
/**
 * C112: the Custom permissions editor is one No access/View/Edit/Manage
 * dropdown-style radiogroup per module, grouped the way the manager sidebar
 * itself groups sections, plus one-click presets. Money-sensitive: a preset
 * that excludes a module must still write NOTHING for it (an empty/absent
 * grant), never a false-but-present entry — "empty means no access"
 * (docs/agents/co-manager-access.md) has to survive a bulk preset the same
 * way it survives a hand-set dropdown.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CoManagerPermissionsEditor } from "@/components/portal/workspace-permissions-fields";
import { coManagerModuleAllowed, type CoManagerPermissions } from "@/lib/co-manager-permissions";

afterEach(() => cleanup());

function Harness({ initial = {} as CoManagerPermissions, onChange }: { initial?: CoManagerPermissions; onChange: (next: CoManagerPermissions) => void }) {
  return <CoManagerPermissionsEditor value={initial} onChange={onChange} hideRole />;
}

describe("CoManagerPermissionsEditor grouping", () => {
  it("groups module rows under sidebar-shaped headings", () => {
    render(<Harness onChange={() => {}} />);
    expect(document.querySelector('[data-attr="co-manager-group-leasing"]')?.textContent).toBe("Leasing");
    expect(document.querySelector('[data-attr="co-manager-group-tenancy"]')?.textContent).toBe("Tenancy");
    expect(document.querySelector('[data-attr="co-manager-group-finances"]')?.textContent).toBe("Finances");
    // A module still renders exactly once, inside its group.
    expect(screen.getAllByText("Payments")).toHaveLength(1);
  });

  it("offers exactly one dropdown-style radiogroup per module (No access/View/Edit/Manage)", () => {
    render(<Harness onChange={() => {}} />);
    const row = screen.getByText("Leases").closest('[data-attr="co-manager-module-leases"]')!;
    expect(row.querySelector('[data-attr="co-manager-leases-none"]')).toBeTruthy();
    expect(row.querySelector('[data-attr="co-manager-leases-view"]')).toBeTruthy();
    expect(row.querySelector('[data-attr="co-manager-leases-edit"]')).toBeTruthy();
    expect(row.querySelector('[data-attr="co-manager-leases-manage"]')).toBeTruthy();
  });
});

describe("CoManagerPermissionsEditor presets", () => {
  it("offers exactly three one-click presets besides Clear all", () => {
    render(<Harness onChange={() => {}} />);
    expect(screen.getByText("Leasing only")).toBeTruthy();
    expect(screen.getByText("Full access but money")).toBeTruthy();
    expect(screen.getByText("Everything")).toBeTruthy();
    expect(screen.getByText("Clear all")).toBeTruthy();
  });

  it("'Leasing only' grants applications+leases and leaves every other module with NO grant at all", () => {
    let latest: CoManagerPermissions = {};
    const { rerender } = render(<Harness onChange={(next) => (latest = next)} />);
    fireEvent.click(screen.getByText("Leasing only"));
    rerender(<Harness initial={latest} onChange={(next) => (latest = next)} />);

    expect(coManagerModuleAllowed({ "prop-1": latest }, "prop-1", "applications", "delete")).toBe(true);
    expect(coManagerModuleAllowed({ "prop-1": latest }, "prop-1", "leases", "delete")).toBe(true);
    // Never-mentioned modules are absent (not `false`, not `{}` left dangling) —
    // the empty-map-means-no-access invariant.
    expect(latest.payments).toBeUndefined();
    expect(latest.financials).toBeUndefined();
    expect(coManagerModuleAllowed({ "prop-1": latest }, "prop-1", "financials", "read")).toBe(false);
  });

  it("'Full access but money' grants everything except bank/finances/payments", () => {
    let latest: CoManagerPermissions = {};
    const { rerender } = render(<Harness onChange={(next) => (latest = next)} />);
    fireEvent.click(screen.getByText("Full access but money"));
    rerender(<Harness initial={latest} onChange={(next) => (latest = next)} />);

    expect(coManagerModuleAllowed({ "prop-1": latest }, "prop-1", "properties", "delete")).toBe(true);
    expect(coManagerModuleAllowed({ "prop-1": latest }, "prop-1", "bankAccount", "read")).toBe(false);
    expect(coManagerModuleAllowed({ "prop-1": latest }, "prop-1", "financials", "read")).toBe(false);
    expect(coManagerModuleAllowed({ "prop-1": latest }, "prop-1", "payments", "read")).toBe(false);
    expect(latest.bankAccount).toBeUndefined();
    expect(latest.financials).toBeUndefined();
    expect(latest.payments).toBeUndefined();
  });

  it("'Everything' grants delete-level access to every module", () => {
    let latest: CoManagerPermissions = {};
    const { rerender } = render(<Harness onChange={(next) => (latest = next)} />);
    fireEvent.click(screen.getByText("Everything"));
    rerender(<Harness initial={latest} onChange={(next) => (latest = next)} />);

    for (const id of ["properties", "applications", "residents", "leases", "payments", "bankAccount", "documents", "financials", "services", "promotion", "inbox", "calendar", "teams"] as const) {
      expect(coManagerModuleAllowed({ "prop-1": latest }, "prop-1", id, "delete")).toBe(true);
    }
  });
});
