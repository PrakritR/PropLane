import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/components/portal/inspections-panel.tsx"),
  "utf8",
);

/**
 * Night UX sweep — Resident Inspections rendered as six floating skeleton
 * cards on a bare background with no sidebar/header at all while the panel's
 * own session read was still pending. `InspectionsPanel` returned a bare,
 * unstyled `<p>Loading inspections…</p>` for that window, unlike every other
 * list content area (Residents, Vendors, …) which shows the shared
 * shimmering `ListSkeleton`. The portal shell is mounted by the caller
 * (`ResidentInspectionsPage` / `ManagerInspectionsPage`), so only this
 * content slot needed to change.
 */
describe("InspectionsPanel loading state matches the shared list skeleton", () => {
  it("renders the shared ListSkeleton instead of bare loading text while the session resolves", () => {
    expect(source).toContain('import { ListSkeleton } from "@/components/ui/list-skeleton";');
    expect(source).toMatch(/if \(!ready\) return <ListSkeleton/);
    expect(source).not.toContain("Loading inspections…");
  });
});
