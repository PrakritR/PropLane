import type { DemoApplicantRow } from "@/data/demo-portal";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";

const COSIGNER_LIST_SELECTION_PREFIX = "cosigner:";

/** Stable list-checkbox id for a co-signer row nested under a signer application. */
export function cosignerListSelectionId(
  signerApplicationId: string,
  sub: CosignerSubmission,
  index: number,
): string {
  const signerKey = normalizeApplicationAxisId(signerApplicationId).toUpperCase();
  const subKey = sub.id?.trim() || String(index);
  return `${COSIGNER_LIST_SELECTION_PREFIX}${signerKey}:${subKey}`;
}

export function isCosignerListSelectionId(id: string): boolean {
  return id.startsWith(COSIGNER_LIST_SELECTION_PREFIX);
}

export type ResolvedCosignerListSelection = {
  signerRow: DemoApplicantRow;
  sub: CosignerSubmission;
  index: number;
};

function findCosignerSubmission(
  subs: CosignerSubmission[],
  subKey: string,
): { sub: CosignerSubmission; index: number } | null {
  const byId = subs.findIndex((s) => s.id?.trim() === subKey);
  if (byId >= 0) return { sub: subs[byId]!, index: byId };
  const idx = Number.parseInt(subKey, 10);
  if (!Number.isNaN(idx) && idx >= 0 && idx < subs.length) return { sub: subs[idx]!, index: idx };
  return null;
}

/** Resolve a cosigner list selection id back to signer row + submission. */
export function resolveCosignerListSelection(
  selectionId: string,
  rows: DemoApplicantRow[],
  cosignerSubmissionsBySigner: Map<string, CosignerSubmission[]>,
): ResolvedCosignerListSelection | null {
  if (!isCosignerListSelectionId(selectionId)) return null;
  const payload = selectionId.slice(COSIGNER_LIST_SELECTION_PREFIX.length);
  const colon = payload.indexOf(":");
  if (colon < 0) return null;
  const signerKey = payload.slice(0, colon);
  const subKey = payload.slice(colon + 1);
  if (!signerKey || !subKey) return null;

  const signerRow =
    rows.find((row) => normalizeApplicationAxisId(row.id).toUpperCase() === signerKey) ?? null;
  if (!signerRow) return null;

  const subs = cosignerSubmissionsBySigner.get(signerKey) ?? [];
  const match = findCosignerSubmission(subs, subKey);
  if (!match) return null;

  return { signerRow, sub: match.sub, index: match.index };
}
