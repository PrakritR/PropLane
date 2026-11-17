/**
 * Dashboard figures that name something another screen also counts are computed here, from the
 * same functions that screen uses, so the two cannot drift.
 */
import type { DemoApplicantRow } from "@/data/demo-portal";
import { applicationListTabForRow, countApplicationsByTab } from "@/lib/rental-application/in-progress-application";

/** Applications page scoping: no booking rows, no merged duplicates, visible to the viewer, in the workspace. */
export function scopeApplicationsLikeThePage(
  rows: readonly DemoApplicantRow[],
  scope: {
    isBookingResidencyRow: (row: DemoApplicantRow) => boolean;
    visible: (row: DemoApplicantRow) => boolean;
    inWorkspace: (row: DemoApplicantRow) => boolean;
  },
): DemoApplicantRow[] {
  return rows.filter((r) => !scope.isBookingResidencyRow(r) && !r.mergedInto && scope.visible(r) && scope.inWorkspace(r));
}

/** The rows of the Applications page's Pending tab, and its count: the card's number. */
export function pendingTabApplications(scoped: readonly DemoApplicantRow[]): DemoApplicantRow[] {
  return scoped.filter((r) => applicationListTabForRow(r) === "pending");
}

export function pendingTabApplicationCount(scoped: readonly DemoApplicantRow[]): number {
  return countApplicationsByTab(scoped).pending;
}

/** Residents = people living there today: the occupancy snapshot's people figure; null while unknown. */
export function residentsLivingToday(occupancy: { occupiedToday: number } | null): number | null {
  return occupancy ? occupancy.occupiedToday : null;
}
