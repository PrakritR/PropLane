import { isDemoModeActive } from "@/lib/demo/demo-session";
import { emitAdminUi } from "@/lib/demo-admin-ui";
import { normalizeBugFeedbackRow } from "@/lib/portal-bug-feedback-utils";

export type BugFeedbackType = "bug" | "feedback";
export type BugFeedbackReporterRole = "manager" | "resident" | "admin" | "pro" | "vendor";
export type BugFeedbackStatus = "open" | "in_progress" | "completed";
export type BugSeverity = "low" | "medium" | "high" | "critical";
/**
 * N087: the redesigned feedback form's Type dropdown — Bug / Idea / Question.
 * Finer than {@link BugFeedbackType}'s admin bucket (bug vs. feedback), so it
 * rides along inside the same `row_data` JSON payload rather than a new
 * column: no schema change, and admin's Bugs/Feedback split still works off
 * `type`, derived from this with {@link reportTypeForKind}.
 */
export type BugFeedbackKind = "bug" | "idea" | "question";

export function reportTypeForKind(kind: BugFeedbackKind): BugFeedbackType {
  return kind === "bug" ? "bug" : "feedback";
}

export type PortalBugFeedbackRow = {
  id: string;
  type: BugFeedbackType;
  /** Present once a row was submitted through the N087 form; absent on older rows. */
  reportKind?: BugFeedbackKind;
  reporterUserId: string;
  reporterName: string;
  reporterEmail: string;
  reporterRole: BugFeedbackReporterRole;
  pageUrl: string;
  title: string;
  description: string;
  stepsToReproduce?: string;
  severity?: BugSeverity;
  status: BugFeedbackStatus;
  adminNotes?: string;
  attachmentUrls?: string[];
  createdAt: string;
  updatedAt: string;
};

let cachedRows: PortalBugFeedbackRow[] = [];
let syncedFromServer = false;

function isBrowser() {
  return typeof window !== "undefined";
}

function rid() {
  return `bf-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function writeLocal(rows: PortalBugFeedbackRow[]) {
  if (!isBrowser()) return;
  cachedRows = rows;
  emitAdminUi();
}

async function persistRow(row: PortalBugFeedbackRow) {
  if (!isBrowser()) return;
  // Demo sandbox is local-only: the cached-row update already drove the UI;
  // never write feedback to the real backend.
  if (isDemoModeActive()) return;
  const res = await fetch("/api/portal-bug-feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "upsert", row }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not save feedback.");
  }
}

export function readBugFeedbackRows(): PortalBugFeedbackRow[] {
  return cachedRows;
}

/** Demo seed: load feedback rows into the local cache (local-only, no server). */
export function seedDemoBugFeedback(rows: PortalBugFeedbackRow[]): void {
  cachedRows = rows;
  syncedFromServer = true;
  if (isBrowser()) emitAdminUi();
}

export type BugFeedbackSyncResult = {
  rows: PortalBugFeedbackRow[];
  error?: string;
  schemaMissing?: boolean;
};

export async function syncBugFeedbackFromServer(opts?: {
  force?: boolean;
}): Promise<BugFeedbackSyncResult> {
  if (!isBrowser()) return { rows: [] };
  if (isDemoModeActive()) return { rows: cachedRows };
  if (syncedFromServer && !opts?.force) return { rows: cachedRows };
  try {
    const res = await fetch("/api/portal-bug-feedback", { credentials: "include" });
    const data = (await res.json().catch(() => ({}))) as { rows?: unknown[]; error?: string };
    if (!res.ok) {
      const error = data.error ?? "Could not load feedback.";
      const schemaMissing =
        error.toLowerCase().includes("portal_bug_feedback_records") &&
        error.toLowerCase().includes("schema cache");
      return { rows: cachedRows, error, schemaMissing };
    }
    const rows = (Array.isArray(data.rows) ? data.rows : [])
      .map(normalizeBugFeedbackRow)
      .filter((r): r is PortalBugFeedbackRow => Boolean(r));
    cachedRows = rows;
    syncedFromServer = true;
    return { rows };
  } catch {
    return { rows: cachedRows, error: "Could not load feedback." };
  }
}

export async function submitBugFeedbackReport(input: {
  type: BugFeedbackType;
  /** N087 Type dropdown selection (Bug / Idea / Question), when submitted through that form. */
  reportKind?: BugFeedbackKind;
  reporterUserId: string;
  reporterName: string;
  reporterEmail: string;
  reporterRole: BugFeedbackReporterRole;
  pageUrl?: string;
  title: string;
  description: string;
  stepsToReproduce?: string;
  severity?: BugSeverity;
  attachmentUrls?: string[];
}): Promise<PortalBugFeedbackRow> {
  const now = new Date().toISOString();
  const row: PortalBugFeedbackRow = {
    id: rid(),
    type: input.type,
    reportKind: input.reportKind,
    reporterUserId: input.reporterUserId,
    reporterName: input.reporterName.trim(),
    reporterEmail: input.reporterEmail.trim().toLowerCase(),
    reporterRole: input.reporterRole,
    pageUrl: (input.pageUrl ?? "").trim(),
    title: input.title.trim(),
    description: input.description.trim(),
    stepsToReproduce: input.type === "bug" ? input.stepsToReproduce?.trim() : undefined,
    severity: input.type === "bug" ? input.severity ?? "medium" : undefined,
    attachmentUrls: input.attachmentUrls?.length ? input.attachmentUrls : undefined,
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
  await persistRow(row);
  writeLocal([row, ...cachedRows.filter((r) => r.id !== row.id)]);
  return row;
}

export async function updateBugFeedbackRow(
  id: string,
  patch: Partial<Pick<PortalBugFeedbackRow, "status" | "adminNotes">>,
): Promise<void> {
  const idx = cachedRows.findIndex((r) => r.id === id);
  if (idx === -1) return;
  const next: PortalBugFeedbackRow = {
    ...cachedRows[idx]!,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  const rows = [...cachedRows];
  rows[idx] = next;
  writeLocal(rows);
  await persistRow(next);
}

export async function deleteBugFeedbackRow(id: string, opts?: { admin?: boolean }): Promise<void> {
  if (!isBrowser()) return;
  const trimmedId = id.trim();
  if (!trimmedId) throw new Error("Missing feedback id.");
  // Demo sandbox is local-only: delete from the cache without touching the server.
  if (isDemoModeActive()) {
    writeLocal(cachedRows.filter((r) => r.id !== trimmedId));
    return;
  }
  const endpoint = opts?.admin ? "/api/admin/portal-bug-feedback" : "/api/portal-bug-feedback";
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "delete", id: trimmedId }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; deleted?: number };
  if (!res.ok) {
    throw new Error(body.error ?? "Could not delete feedback.");
  }
  if (typeof body.deleted === "number" && body.deleted < 1) {
    throw new Error("Could not delete feedback.");
  }
  writeLocal(cachedRows.filter((r) => r.id !== trimmedId));
}
