import type { ManagerApplicationBucket } from "@/data/demo-portal";
import type { ResidentLeaseDocumentRow } from "@/lib/resident-lease-documents";

/**
 * Resident Documents header buttons (captain, 2026-09-25: every resident
 * list gets three right-side header buttons named per page — Documents get
 * To sign / Signed / Archived, replacing the four real category tabs).
 * Application / Lease / Rent receipts / Other documents remain fully
 * reachable — they move into the header's Filter popover as a "Kind" field
 * (`RESIDENT_DOCUMENT_KIND_ORDER`) instead of being a top destination
 * (C142: keep every real tab, invent nothing).
 *
 * - **To sign** — a lease or application document still awaiting this
 *   resident's own action (an unsigned lease, a pending application).
 * - **Signed** — the CURRENT executed lease.
 * - **Archived** — everything settled or superseded: an older signed lease
 *   snapshot from a prior renewal, a resolved application, every rent
 *   receipt, every "Other" upload (neither of those two ever carries a
 *   signature workflow).
 */
export type ResidentDocumentTab = "to-sign" | "signed" | "archived";

export const RESIDENT_DOCUMENT_TAB_ORDER: ResidentDocumentTab[] = ["to-sign", "signed", "archived"];

export const RESIDENT_DOCUMENT_TAB_LABELS: Record<ResidentDocumentTab, string> = {
  "to-sign": "To sign",
  signed: "Signed",
  archived: "Archived",
};

export function parseResidentDocumentTab(raw: string | undefined | null): ResidentDocumentTab {
  if (raw && (RESIDENT_DOCUMENT_TAB_ORDER as readonly string[]).includes(raw)) {
    return raw as ResidentDocumentTab;
  }
  return "to-sign";
}

/** The four real document categories — now a "Kind" filter, not a top tab. */
export type ResidentDocumentKind = "application" | "lease" | "receipts" | "other";

export const RESIDENT_DOCUMENT_KIND_ORDER: ResidentDocumentKind[] = ["application", "lease", "receipts", "other"];

export const RESIDENT_DOCUMENT_KIND_LABELS: Record<ResidentDocumentKind, string> = {
  application: "Application",
  lease: "Lease",
  receipts: "Rent receipts",
  other: "Other documents",
};

export function parseResidentDocumentKindFilter(raw: string | undefined | null): ResidentDocumentKind | null {
  if (raw === "application" || raw === "lease" || raw === "receipts" || raw === "other") return raw;
  return null;
}

/**
 * Which bucket a bare legacy `/documents/{kind}` list URL (no detail id)
 * lands on, with that kind preselected in the Filter popover — so an old
 * bookmark or emailed link keeps landing somewhere sensible instead of 404ing.
 */
export const RESIDENT_DOCUMENT_KIND_DEFAULT_TAB: Record<ResidentDocumentKind, ResidentDocumentTab> = {
  application: "to-sign",
  lease: "to-sign",
  receipts: "archived",
  other: "archived",
};

/** A pending application is still awaiting a decision; approved/rejected is settled. */
export function residentDocumentTabForApplication(bucket: ManagerApplicationBucket): ResidentDocumentTab {
  return bucket === "pending" ? "to-sign" : "archived";
}

/**
 * `filterBucket` already answers the real question — pending (awaiting a
 * signature) vs. signed (executed) — via the existing
 * `src/lib/resident-lease-documents.ts` / `ResidentLeaseListTable`
 * `statusFilter` prop, which this file reuses as-is rather than adding a
 * finer current-vs-superseded split inside WS1's lease list files.
 */
export function residentDocumentTabForLease(
  row: Pick<ResidentLeaseDocumentRow, "filterBucket">,
): ResidentDocumentTab {
  return row.filterBucket === "pending" ? "to-sign" : "signed";
}

/** A rent receipt is always a settled, historical record. */
export function residentDocumentTabForReceipt(): ResidentDocumentTab {
  return "archived";
}

/** A resident-uploaded / manager-shared "Other" document has no signature workflow. */
export function residentDocumentTabForOther(): ResidentDocumentTab {
  return "archived";
}
