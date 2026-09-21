/**
 * Shared record-kind vocabulary for the one-portal-system record shell
 * (PLAN-0920-1058). Kept tiny and dependency-free so both the record-section
 * registry (worker 1A, `record-sections.ts` / `record-section-renderers.tsx`)
 * and record-linked communication (worker 1B, this area) import the exact
 * same names instead of drifting.
 *
 * This file owns ONLY the kind vocabulary, a `recordRef` shape/validator, and
 * a route-path helper. It does not own the section registry itself —
 * `record-sections.ts` is worker 1A's file.
 */

export const RECORD_KINDS = [
  "property",
  "resident",
  "payment",
  "outgoing-payment",
  "lease",
  "application",
  "inspection",
  "service",
  "task",
  "vendor",
  "tour",
  "booking",
  "document",
] as const;

export type RecordKind = (typeof RECORD_KINDS)[number];

export function isRecordKind(value: unknown): value is RecordKind {
  return typeof value === "string" && (RECORD_KINDS as readonly string[]).includes(value);
}

/** A label on a thread (or any other cross-reference) pointing at one record. Never an authorization grant. */
export type RecordRef = {
  kind: RecordKind;
  id: string;
  label: string;
};

const MAX_RECORD_REF_ID_LENGTH = 200;
const MAX_RECORD_REF_LABEL_LENGTH = 140;

/**
 * Structural validation only — this never authorizes anything. A caller that
 * stamps a `recordRef` onto a thread must still independently authorize the
 * send; the ref is a label for display and filtering, never a grant.
 */
export function isValidRecordRef(value: unknown): value is RecordRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (!isRecordKind(candidate.kind)) return false;
  if (typeof candidate.id !== "string") return false;
  if (typeof candidate.label !== "string") return false;
  const id = candidate.id.trim();
  const label = candidate.label.trim();
  if (!id || id.length > MAX_RECORD_REF_ID_LENGTH) return false;
  if (!label || label.length > MAX_RECORD_REF_LABEL_LENGTH) return false;
  return true;
}

/** Trims and length-caps a candidate recordRef; returns null when it does not validate. */
export function normalizeRecordRef(value: unknown): RecordRef | null {
  if (!isValidRecordRef(value)) return null;
  return {
    kind: value.kind,
    id: value.id.trim().slice(0, MAX_RECORD_REF_ID_LENGTH),
    label: value.label.trim().slice(0, MAX_RECORD_REF_LABEL_LENGTH),
  };
}

export type RecordPortalRole = "manager" | "resident" | "vendor";

/**
 * Section slug a record kind resolves to under `/portal`, `/resident`, or
 * `/vendor`. Forward-looking: the record-page routes themselves are the
 * record-section registry's build (worker 1A / PLAN-0920-1058); this map only
 * has to stay consistent so a chip built today opens the right page once that
 * registry lands. A role/kind pair with no meaningful page returns `null`.
 */
const RECORD_SECTION_BY_ROLE: Record<RecordPortalRole, Partial<Record<RecordKind, string>>> = {
  manager: {
    property: "properties",
    resident: "residents",
    payment: "payments",
    "outgoing-payment": "payments",
    lease: "leases",
    application: "applications",
    inspection: "inspections",
    service: "services",
    task: "tasks",
    vendor: "vendors",
    tour: "tours",
    booking: "bookings",
    document: "documents",
  },
  resident: {
    payment: "payments",
    "outgoing-payment": "payments",
    lease: "lease",
    application: "applications",
    inspection: "inspections",
    service: "services",
    tour: "tour",
    document: "documents",
  },
  vendor: {
    service: "work-orders",
    payment: "financials",
    "outgoing-payment": "financials",
    booking: "calendar",
    document: "documents",
  },
};

/**
 * Build the record's Communication route: `/<portal>/<section>/<id>/communication`.
 * Returns `null` when this role has no page for that kind (e.g. a resident
 * viewing a `vendor` ref) — callers should render the chip as plain text
 * rather than a dead link in that case.
 */
export function recordRoutePath(role: RecordPortalRole, kind: RecordKind, id: string, tab = "communication"): string | null {
  const section = RECORD_SECTION_BY_ROLE[role][kind];
  if (!section) return null;
  const base = role === "manager" ? "/portal" : `/${role}`;
  return `${base}/${section}/${encodeURIComponent(id)}/${tab}`;
}
