import type { DemoApplicantRow } from "@/data/demo-portal";
import { isBookingResidencyRow, normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { isDraftShapedApplicationRow } from "@/lib/rental-application/draft-shape";

/**
 * One application per person per house.
 *
 * A draft write for an applicant (the signed-in subject, else the lowercased email of a guest) and a
 * house that already has an OPEN application (a draft, or a submission still pending) is the SAME
 * application: the server keeps the existing id, merges the incoming fields into it and answers with
 * that id, so a second visit - another browser, another device, a re-opened tab - resumes instead of
 * stacking a duplicate row. These are the pure decisions; the reads live in
 * `application-draft-dedupe.server.ts` and the writes stay in `POST /api/manager-applications`.
 */

export type OpenApplicationCandidate = {
  id: string;
  row: DemoApplicantRow;
  residentEmail?: string | null;
  updatedAt?: string | null;
};

/** The house a row is for: the same fallback order the submit paths read. */
export function openApplicationPropertyKey(
  row: Pick<DemoApplicantRow, "propertyId" | "assignedPropertyId" | "application">,
): string {
  return (
    (row.propertyId ?? "").trim() ||
    (row.assignedPropertyId ?? "").trim() ||
    (row.application?.propertyId ?? "").trim()
  );
}

/** An application a second write can still fold into: pending, not withdrawn, not already merged away. */
export function isOpenApplicationRow(row: DemoApplicantRow): boolean {
  if (row.bucket !== "pending") return false;
  if (row.withdrawnAt) return false;
  if (row.manuallyAdded === true || isBookingResidencyRow(row)) return false;
  if (row.mergedInto) return false;
  return true;
}

function roomOf(row: Pick<DemoApplicantRow, "application">): string {
  return (row.application?.roomChoice1 ?? "").trim();
}

const idKey = (id: string) => normalizeApplicationAxisId(id).toUpperCase();

/**
 * The open application this write folds into, or null.
 *
 * - Signed in: only a row bound to that same `residentUserId`. An email is never enough.
 * - Guest: only a row that is itself a guest row (no `residentUserId`) with the same email.
 * - A SUBMITTED row never takes a draft for a different, explicitly named room: applying to a second
 *   room of the house stays possible (the room-level duplicate guard still stops the same room twice).
 * - Submitted beats draft; among drafts the furthest along wins, then the newest (the same order the
 *   cleanup script keeps).
 */
export function selectOpenApplicationMatch(
  candidates: readonly OpenApplicationCandidate[],
  input: {
    subject: string | null;
    email: string;
    propertyId: string;
    excludeId?: string | null;
    incomingRoom?: string | null;
  },
): OpenApplicationCandidate | null {
  const email = input.email.trim().toLowerCase();
  const propertyId = input.propertyId.trim();
  if (!propertyId || (!input.subject && !email)) return null;
  const exclude = input.excludeId ? idKey(input.excludeId) : "";
  const room = (input.incomingRoom ?? "").trim();

  const matches = candidates.filter((candidate) => {
    const row = candidate.row;
    if (!row || exclude === idKey(candidate.id)) return false;
    if (!isOpenApplicationRow(row)) return false;
    if (openApplicationPropertyKey(row) !== propertyId) return false;
    if (input.subject) {
      if (row.residentUserId !== input.subject) return false;
    } else {
      if (row.residentUserId) return false;
      const rowEmail = (candidate.residentEmail ?? row.email ?? "").trim().toLowerCase();
      if (!rowEmail || rowEmail !== email) return false;
    }
    if (!isDraftShapedApplicationRow(row) && room && roomOf(row) && roomOf(row) !== room) return false;
    return true;
  });
  if (matches.length === 0) return null;
  const rank = (candidate: OpenApplicationCandidate) => {
    const app = candidate.row.application as { wizardStep?: number; wizardMaxStepReached?: number } | undefined;
    const submitted = isDraftShapedApplicationRow(candidate.row) ? 0 : 1;
    const step = Math.max(Number(app?.wizardMaxStepReached) || 0, Number(app?.wizardStep) || 0);
    const updated = Date.parse(candidate.updatedAt ?? "") || 0;
    return [submitted, step, updated] as const;
  };
  return [...matches].sort((a, b) => {
    const [as, ast, au] = rank(a);
    const [bs, bst, bu] = rank(b);
    return bs - as || bst - ast || bu - au;
  })[0]!;
}

/** A blank answer: it must not erase what the kept row already holds. */
function isBlankAnswer(value: unknown): boolean {
  if (value === undefined || value === null || value === "" || value === false || value === 0) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

/**
 * Fold an incoming draft into the kept row. The kept row's id, start stamp and every field the incoming
 * draft leaves blank survive; any answer the incoming draft actually holds wins. This runs once, on the
 * first write that lands on the kept row - afterwards the client writes under the kept id and the write
 * is an ordinary full replace.
 */
export function mergeDraftIntoExisting(existing: DemoApplicantRow, incoming: DemoApplicantRow): DemoApplicantRow {
  const application: Record<string, unknown> = { ...(existing.application ?? {}) };
  for (const [key, value] of Object.entries(incoming.application ?? {})) {
    if (!isBlankAnswer(value)) application[key] = value;
  }
  const maxStep = Math.max(
    Number((existing.application as { wizardMaxStepReached?: number } | undefined)?.wizardMaxStepReached ?? 0) || 0,
    Number((incoming.application as { wizardMaxStepReached?: number } | undefined)?.wizardMaxStepReached ?? 0) || 0,
  );
  if (maxStep > 0) application.wizardMaxStepReached = maxStep;
  // Resume where the person stopped, not at the blank first step of the visit that merged.
  const existingStep = (existing.application as { wizardStep?: number } | undefined)?.wizardStep;
  if (typeof existingStep === "number" && existingStep > 0) application.wizardStep = existingStep;
  return {
    ...existing,
    ...incoming,
    id: existing.id,
    name: incoming.name?.trim() ? incoming.name : existing.name,
    email: incoming.email?.trim() ? incoming.email : existing.email,
    detail: existing.detail || incoming.detail,
    application: application as DemoApplicantRow["application"],
  };
}
