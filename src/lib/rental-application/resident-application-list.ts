import type { DemoApplicantRow } from "@/data/demo-portal";

/**
 * Stable grouping key for ordering a resident's applications: the listing
 * IDENTIFIER, never the resolved display title.
 *
 * A row's `property` string is a DISPLAY value that resolves asynchronously —
 * it starts as the raw listing slug (e.g. `mgr-te-demo-lakeview`) and only
 * becomes the human title (`Lakeview Flats`) once the property-pipeline catalog
 * has loaded and a later write (draft-sync / edit / server re-sync) rewrites it.
 * Sorting on that mutable string made the list re-sort — and rows visibly hop —
 * every time a `MANAGER_APPLICATIONS_EVENT` fired after such a resolution.
 * `propertyId` is fixed from submission, so it groups the same listing's rows
 * together AND keeps their order invariant to title resolution.
 */
export function applicationSortPropertyKey(row: DemoApplicantRow): string {
  return (
    row.propertyId?.trim() ||
    row.application?.propertyId?.trim() ||
    row.assignedPropertyId?.trim() ||
    ""
  );
}

/**
 * Order applications for the resident list. Primary key is the STABLE property
 * identifier ({@link applicationSortPropertyKey}); the tie-break is the immutable
 * application id. Neither key changes when a listing title resolves from its slug
 * or when a row is expanded, so the list stays exactly where it is.
 *
 * Note: `name` is deliberately NOT a sort key — application ids are unique, so the
 * id tie-break is already total, and keying on the async-backfilled applicant name
 * ("Applicant" → real name) would reintroduce the same reorder-on-resolution bug.
 */
export function sortResidentApplicationRows(rows: DemoApplicantRow[]): DemoApplicantRow[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...rows].sort((a, b) => {
    const byProperty = collator.compare(applicationSortPropertyKey(a), applicationSortPropertyKey(b));
    if (byProperty !== 0) return byProperty;
    return collator.compare(a.id, b.id);
  });
}

/**
 * A withdrawn application is a reversible, non-destructive state: it leaves the
 * resident's active list while the manager keeps the record and its history.
 */
export function isWithdrawnApplicationRow(row: Pick<DemoApplicantRow, "withdrawnAt">): boolean {
  return Boolean(row.withdrawnAt && String(row.withdrawnAt).trim());
}

/** A pending application the resident may withdraw (not approved/rejected, not already withdrawn). */
export function canResidentWithdrawApplication(
  row: Pick<DemoApplicantRow, "bucket" | "withdrawnAt">,
): boolean {
  return row.bucket === "pending" && !isWithdrawnApplicationRow(row);
}

/**
 * How far an unsent application got: steps finished out of the wizard's total. The furthest step the
 * person reached counts (they may have gone back), and the step they are ON is not finished yet.
 */
export function draftStepProgress(
  row: Pick<DemoApplicantRow, "application">,
  totalSteps: number,
): { done: number; total: number } {
  const app = row.application as { wizardStep?: number; wizardMaxStepReached?: number } | undefined;
  const reached = Math.max(Number(app?.wizardMaxStepReached) || 0, Number(app?.wizardStep) || 0);
  return { done: Math.min(Math.max(reached - 1, 0), totalSteps), total: totalSteps };
}

const draftHouseKey = (row: DemoApplicantRow) => applicationSortPropertyKey(row);

/**
 * One row per house: several UNSENT drafts the same person left for one house are one application, shown
 * once - the furthest along, then the newest. A draft that a sent application for the same house (and the
 * same room, or no room yet) already covers is not an application of its own, so it is not listed.
 * Sent, approved and declined rows are never touched.
 */
export function collapseDuplicateResidentDrafts(
  rows: DemoApplicantRow[],
  isDraft: (row: DemoApplicantRow) => boolean,
  totalSteps: number,
): DemoApplicantRow[] {
  const roomOf = (row: DemoApplicantRow) => (row.application?.roomChoice1 ?? "").trim();
  const sentByHouse = new Map<string, DemoApplicantRow[]>();
  for (const row of rows) {
    if (isDraft(row) || row.bucket !== "pending") continue;
    const list = sentByHouse.get(draftHouseKey(row)) ?? [];
    list.push(row);
    sentByHouse.set(draftHouseKey(row), list);
  }
  const bestDraft = new Map<string, DemoApplicantRow>();
  const score = (row: DemoApplicantRow) => [
    draftStepProgress(row, totalSteps).done,
    Date.parse(String((row as { updatedAt?: string }).updatedAt ?? "")) || 0,
  ];
  for (const row of rows) {
    if (!isDraft(row)) continue;
    const key = draftHouseKey(row);
    const covered = (sentByHouse.get(key) ?? []).some((sent) => !roomOf(row) || !roomOf(sent) || roomOf(sent) === roomOf(row));
    if (covered) continue;
    const current = bestDraft.get(key);
    if (!current) {
      bestDraft.set(key, row);
      continue;
    }
    const [a1, a2] = score(row);
    const [b1, b2] = score(current);
    if (a1! > b1! || (a1 === b1 && a2! > b2!)) bestDraft.set(key, row);
  }
  return rows.filter((row) => !isDraft(row) || bestDraft.get(draftHouseKey(row)) === row);
}
