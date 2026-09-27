/**
 * Workspace lease document library (night/custom-lease).
 *
 * A small, workspace-scoped catalog of previously uploaded lease PDFs
 * (`lease_document_library`, additive migration
 * `20260925193000_lease_document_library.sql`). Storage bytes stay exactly
 * where `lease-template-storage.ts` already puts them — the private
 * `lease-templates` bucket, streamed only through the existing
 * `/api/portal/lease-template` re-authorizing route. This module holds the
 * metadata shape (name, path, default flag, signature-field placements) and
 * the client fetch helpers for the row-level API
 * (`/api/portal/lease-library`).
 *
 * Field placements are PURE, normalized data: every coordinate is 0..1
 * against the page's own width/height, so a placement is resolution- and
 * zoom-independent. `normalizeLeaseDocumentLibraryFields` fails CLOSED on
 * garbage input (an unrecognized `kind`/`role`, a non-finite coordinate, or an
 * out-of-range value is dropped, never coerced to a guessed default) — the
 * same posture `normalizeUploadedLeaseParse` takes on `row_data`, because this
 * too rides inside a client-writable JSON column.
 */

export type LeaseDocumentFieldRole = "resident" | "manager";
export type LeaseDocumentFieldKind = "signature" | "initials" | "date";

export type LeaseDocumentField = {
  id: string;
  /** 0-based page index. */
  page: number;
  /** Top-left corner, normalized 0..1 against the page's own width/height. */
  x: number;
  y: number;
  /** Box size, normalized 0..1 against the page's own width/height. */
  w: number;
  h: number;
  role: LeaseDocumentFieldRole;
  kind: LeaseDocumentFieldKind;
};

export type LeaseDocumentLibraryEntry = {
  id: string;
  workspaceId: string;
  managerUserId: string;
  name: string;
  storagePath: string;
  fileName: string;
  isDefault: boolean;
  fields: LeaseDocumentField[];
  createdAt: string;
  updatedAt: string;
  /** Stable, browser-loadable URL onto the authorizing route — never a signed URL. */
  url: string;
};

const FIELD_ROLES: readonly LeaseDocumentFieldRole[] = ["resident", "manager"];
const FIELD_KINDS: readonly LeaseDocumentFieldKind[] = ["signature", "initials", "date"];

function finite01(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  // A field is allowed to sit fractionally off either edge (a manager can drag
  // a box so it slightly overhangs a margin) but never wildly off-page — that
  // would almost certainly be corrupted data, not a deliberate placement.
  if (n < -0.25 || n > 1.25) return null;
  return n;
}

function finitePositiveSize(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return null;
  return n;
}

/** One field, or null when the input is not a well-formed placement. Fails closed. */
export function normalizeLeaseDocumentField(raw: unknown): LeaseDocumentField | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : null;
  const page = Number.isInteger(r.page) && (r.page as number) >= 0 ? (r.page as number) : null;
  const x = finite01(r.x);
  const y = finite01(r.y);
  const w = finitePositiveSize(r.w);
  const h = finitePositiveSize(r.h);
  const role = FIELD_ROLES.includes(r.role as LeaseDocumentFieldRole) ? (r.role as LeaseDocumentFieldRole) : null;
  const kind = FIELD_KINDS.includes(r.kind as LeaseDocumentFieldKind) ? (r.kind as LeaseDocumentFieldKind) : null;
  if (id === null || page === null || x === null || y === null || w === null || h === null || !role || !kind) {
    return null;
  }
  return { id, page, x, y, w, h, role, kind };
}

/** Every element that round-trips through `normalizeLeaseDocumentField`; anything else is dropped. */
export function normalizeLeaseDocumentFields(raw: unknown): LeaseDocumentField[] {
  if (!Array.isArray(raw)) return [];
  const out: LeaseDocumentField[] = [];
  for (const item of raw) {
    const field = normalizeLeaseDocumentField(item);
    if (field) out.push(field);
  }
  return out;
}

export function newLeaseDocumentFieldId(): string {
  return `fld_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Default box size for a freshly placed field, normalized 0..1. */
export const DEFAULT_LEASE_DOCUMENT_FIELD_SIZE: Record<LeaseDocumentFieldKind, { w: number; h: number }> = {
  signature: { w: 0.28, h: 0.045 },
  initials: { w: 0.09, h: 0.04 },
  date: { w: 0.16, h: 0.035 },
};

export const LEASE_DOCUMENT_FIELD_LABELS: Record<`${LeaseDocumentFieldRole}:${LeaseDocumentFieldKind}`, string> = {
  "resident:signature": "Resident signature",
  "resident:initials": "Resident initials",
  "resident:date": "Date signed",
  "manager:signature": "Manager signature",
  "manager:initials": "Manager initials",
  "manager:date": "Date signed",
};

export function leaseDocumentFieldLabel(field: Pick<LeaseDocumentField, "role" | "kind">): string {
  return LEASE_DOCUMENT_FIELD_LABELS[`${field.role}:${field.kind}`] ?? "Field";
}

// ---------------------------------------------------------------- client API

export type LeaseDocumentLibraryApiEntry = {
  id: string;
  workspaceId: string;
  managerUserId: string;
  name: string;
  storagePath: string;
  fileName: string;
  isDefault: boolean;
  fields: unknown;
  createdAt: string;
  updatedAt: string;
  url: string;
};

function normalizeApiEntry(raw: LeaseDocumentLibraryApiEntry): LeaseDocumentLibraryEntry {
  return {
    id: raw.id,
    workspaceId: raw.workspaceId,
    managerUserId: raw.managerUserId,
    name: raw.name,
    storagePath: raw.storagePath,
    fileName: raw.fileName,
    isDefault: Boolean(raw.isDefault),
    fields: normalizeLeaseDocumentFields(raw.fields),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    url: raw.url,
  };
}

async function parseJsonResponse<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body?.error || "Something went wrong. Try again.");
  return body;
}

export async function listLeaseDocumentLibrary(workspaceId?: string | null): Promise<LeaseDocumentLibraryEntry[]> {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  const res = await fetch(`/api/portal/lease-library${qs}`, { credentials: "include", cache: "no-store" });
  const body = await parseJsonResponse<{ entries?: LeaseDocumentLibraryApiEntry[] }>(res);
  return (body.entries ?? []).map(normalizeApiEntry);
}

/** Registers an already-uploaded object (via `uploadLeaseTemplateFile`) as a library entry. */
export async function createLeaseDocumentLibraryEntry(args: {
  storagePath: string;
  name: string;
  fileName: string;
  workspaceId?: string | null;
}): Promise<LeaseDocumentLibraryEntry> {
  const res = await fetch("/api/portal/lease-library", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = await parseJsonResponse<{ entry: LeaseDocumentLibraryApiEntry }>(res);
  return normalizeApiEntry(body.entry);
}

export async function renameLeaseDocumentLibraryEntry(id: string, name: string): Promise<LeaseDocumentLibraryEntry> {
  const res = await fetch("/api/portal/lease-library", {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name }),
  });
  const body = await parseJsonResponse<{ entry: LeaseDocumentLibraryApiEntry }>(res);
  return normalizeApiEntry(body.entry);
}

export async function setDefaultLeaseDocumentLibraryEntry(id: string): Promise<LeaseDocumentLibraryEntry> {
  const res = await fetch("/api/portal/lease-library", {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, isDefault: true }),
  });
  const body = await parseJsonResponse<{ entry: LeaseDocumentLibraryApiEntry }>(res);
  return normalizeApiEntry(body.entry);
}

export async function updateLeaseDocumentLibraryFields(
  id: string,
  fields: LeaseDocumentField[],
): Promise<LeaseDocumentLibraryEntry> {
  const res = await fetch("/api/portal/lease-library", {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, fields }),
  });
  const body = await parseJsonResponse<{ entry: LeaseDocumentLibraryApiEntry }>(res);
  return normalizeApiEntry(body.entry);
}

export async function deleteLeaseDocumentLibraryEntry(id: string): Promise<{ ok: true }> {
  const res = await fetch("/api/portal/lease-library", {
    method: "DELETE",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return parseJsonResponse<{ ok: true }>(res);
}
