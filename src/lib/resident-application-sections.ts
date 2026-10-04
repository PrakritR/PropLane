/**
 * The resident Application page's three sections (captain, Oct 3 2026):
 * Sent | Approved | Denied. One pure decision of "which section is this
 * application in", shared by the list, its counts, and the tour gate's
 * client reading, so they can never disagree.
 *
 * Sent is everything the manager has not decided yet: a draft ("Incomplete"),
 * a submitted application awaiting review, and a withdrawn one. Approved and
 * Denied follow the manager's decision (`bucket`).
 */
import type { DemoApplicantRow } from "@/data/demo-portal";
import { applicationStageDisplayLabel } from "@/lib/rental-application/in-progress-application";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import type { PortalRecordRowStatusWord } from "@/components/portal/portal-record-row";

export type ResidentApplicationSection = "sent" | "approved" | "denied";

export const RESIDENT_APPLICATION_SECTION_ORDER: readonly ResidentApplicationSection[] = ["sent", "approved", "denied"];

export const RESIDENT_APPLICATION_SECTION_LABELS: Record<ResidentApplicationSection, string> = {
  sent: "Sent",
  approved: "Approved",
  denied: "Denied",
};

export function residentApplicationSectionOf(row: Pick<DemoApplicantRow, "bucket">): ResidentApplicationSection {
  if (row.bucket === "approved") return "approved";
  if (row.bucket === "rejected") return "denied";
  return "sent";
}

export function countResidentApplicationSections(
  rows: ReadonlyArray<Pick<DemoApplicantRow, "bucket">>,
): Record<ResidentApplicationSection, number> {
  const counts: Record<ResidentApplicationSection, number> = { sent: 0, approved: 0, denied: 0 };
  for (const row of rows) counts[residentApplicationSectionOf(row)] += 1;
  return counts;
}

/** The section to open on: the first one that has rows (Sent when all are empty). */
export function defaultResidentApplicationSection(
  counts: Record<ResidentApplicationSection, number>,
): ResidentApplicationSection {
  return RESIDENT_APPLICATION_SECTION_ORDER.find((id) => counts[id] > 0) ?? "sent";
}

/** The row's status as plain coloured text (never a pill): Incomplete for a draft, Denied for a declined one. */
export function residentApplicationStatusWord(row: DemoApplicantRow): PortalRecordRowStatusWord {
  if (row.bucket === "rejected") return { tone: "bad", text: "Denied" };
  if (isWithdrawnApplicationRow(row)) return { tone: "neutral", text: "Withdrawn" };
  const text = applicationStageDisplayLabel(row);
  if (row.bucket === "approved") return { tone: "ok", text };
  return { tone: text === "Incomplete" ? "warn" : "neutral", text };
}
