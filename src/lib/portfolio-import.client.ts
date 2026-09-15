/**
 * Browser side of portfolio import — typed fetch helpers over
 * `/api/portal/portfolio-import*`. Every call resolves to `{ ok: true, … }` or
 * `{ ok: false, status, error, code?, importId? }`; nothing here throws a raw
 * error, so callers never need a try/catch around a network hiccup.
 *
 * The server owns parsing, mapping, and the draft; this file only shapes
 * requests and responses. See `src/lib/portfolio-import/types.ts` for the
 * draft contract every response carries.
 */

import { readDataUrlFromFile } from "@/lib/resident-document-import.client";
import type {
  PortfolioImportCanonicalKey,
  PortfolioImportCommitResult,
  PortfolioImportDraft,
  PortfolioImportInviteChannel,
  PortfolioImportInviteResult,
  PortfolioImportSourcePreset,
  PortfolioImportStageProgress,
  PortfolioImportStatus,
  PortfolioImportSummary,
} from "@/lib/portfolio-import/types";

/** What the review screen shows about texting invites — read from the GET record. */
export type PortfolioImportMessagingStatus = {
  workNumber: string | null;
  canText: boolean;
  settingsHref: string;
};

/** The full record `GET`/`PATCH` return: status, counts, and the editable draft. */
export type PortfolioImportRecord = {
  importId: string;
  status: PortfolioImportStatus;
  summary: PortfolioImportSummary;
  draft: PortfolioImportDraft;
  result?: PortfolioImportCommitResult;
  messaging?: PortfolioImportMessagingStatus;
};

export type PortfolioImportOk<T> = { ok: true } & T;
export type PortfolioImportErr = {
  ok: false;
  status: number;
  error: string;
  code?: string;
  importId?: string;
};
export type PortfolioImportResult<T> = PortfolioImportOk<T> | PortfolioImportErr;

type RawPayload = {
  error?: string;
  code?: string;
  importId?: string;
  [key: string]: unknown;
};

async function readJson(res: Response): Promise<RawPayload> {
  return (await res.json().catch(() => ({}))) as RawPayload;
}

function toErr(res: Response, payload: RawPayload, fallback: string): PortfolioImportErr {
  return {
    ok: false,
    status: res.status,
    error: typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : fallback,
    code: typeof payload.code === "string" ? payload.code : undefined,
    importId: typeof payload.importId === "string" ? payload.importId : undefined,
  };
}

const NETWORK_ERROR = "Could not reach the server. Check your connection and try again.";

async function fetchJson(input: string, init?: RequestInit): Promise<{ res: Response; payload: RawPayload } | PortfolioImportErr> {
  let res: Response;
  try {
    res = await fetch(input, { credentials: "include", ...init });
  } catch {
    return { ok: false, status: 0, error: NETWORK_ERROR };
  }
  const payload = await readJson(res);
  return { res, payload };
}

function isFetchErr(x: { res: Response; payload: RawPayload } | PortfolioImportErr): x is PortfolioImportErr {
  return "ok" in x && x.ok === false;
}

function recordFromPayload(payload: RawPayload): PortfolioImportRecord {
  return {
    importId: String(payload.importId ?? ""),
    status: payload.status as PortfolioImportStatus,
    summary: payload.summary as PortfolioImportSummary,
    draft: payload.draft as PortfolioImportDraft,
    result: payload.result as PortfolioImportCommitResult | undefined,
    messaging: payload.messaging as PortfolioImportMessagingStatus | undefined,
  };
}

/** Reads `file` to a data URL, then posts it for parsing + first-pass mapping. */
export async function createPortfolioImport(
  file: File,
  presetHint?: PortfolioImportSourcePreset,
): Promise<PortfolioImportResult<{ importId: string; summary: PortfolioImportSummary; draft: PortfolioImportDraft }>> {
  let dataUrl: string;
  try {
    dataUrl = await readDataUrlFromFile(file);
  } catch {
    return { ok: false, status: 0, error: "Could not read that file." };
  }
  const outcome = await fetchJson("/api/portal/portfolio-import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl, fileName: file.name, presetHint }),
  });
  if (isFetchErr(outcome)) return outcome;
  const { res, payload } = outcome;
  if (!res.ok) return toErr(res, payload, "We couldn't read that file.");
  if (!payload.importId || !payload.summary || !payload.draft) {
    return { ok: false, status: res.status, error: "Unexpected response from the server." };
  }
  return {
    ok: true,
    importId: String(payload.importId),
    summary: payload.summary as PortfolioImportSummary,
    draft: payload.draft as PortfolioImportDraft,
  };
}

export async function getPortfolioImport(importId: string): Promise<PortfolioImportResult<PortfolioImportRecord>> {
  const outcome = await fetchJson(`/api/portal/portfolio-import/${encodeURIComponent(importId)}`);
  if (isFetchErr(outcome)) return outcome;
  const { res, payload } = outcome;
  if (!res.ok) return toErr(res, payload, "Could not load that import.");
  return { ok: true, ...recordFromPayload(payload) };
}

/** Any subset of the draft's edit surfaces — see `docs/agents/portfolio-import.md` for what each field means. */
export type PortfolioImportPatch = {
  columns?: Array<{ index: number; key: PortfolioImportCanonicalKey | null }>;
  residents?: Array<{ key: string } & Record<string, unknown>>;
  units?: Array<{ key: string } & Record<string, unknown>>;
  properties?: Array<{ key: string } & Record<string, unknown>>;
  balances?: Array<{ key: string; create: boolean }>;
  issues?: Array<{ id: string; resolved: boolean }>;
};

export async function patchPortfolioImport(
  importId: string,
  patch: PortfolioImportPatch,
): Promise<PortfolioImportResult<PortfolioImportRecord>> {
  const outcome = await fetchJson(`/api/portal/portfolio-import/${encodeURIComponent(importId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (isFetchErr(outcome)) return outcome;
  const { res, payload } = outcome;
  if (!res.ok) return toErr(res, payload, "Could not save that change.");
  return { ok: true, ...recordFromPayload(payload) };
}

export async function discardPortfolioImport(importId: string): Promise<PortfolioImportResult<Record<string, unknown>>> {
  const outcome = await fetchJson(`/api/portal/portfolio-import/${encodeURIComponent(importId)}`, {
    method: "DELETE",
  });
  if (isFetchErr(outcome)) return outcome;
  const { res, payload } = outcome;
  if (!res.ok) return toErr(res, payload, "Could not discard that import.");
  return { ok: true };
}

export async function commitPortfolioImport(
  importId: string,
): Promise<PortfolioImportResult<{ result: PortfolioImportCommitResult; summary: PortfolioImportSummary }>> {
  const outcome = await fetchJson(`/api/portal/portfolio-import/${encodeURIComponent(importId)}/commit`, {
    method: "POST",
  });
  if (isFetchErr(outcome)) return outcome;
  const { res, payload } = outcome;
  if (!res.ok) return toErr(res, payload, "Could not start the import.");
  return {
    ok: true,
    result: payload.result as PortfolioImportCommitResult,
    summary: payload.summary as PortfolioImportSummary,
  };
}

export async function pollPortfolioImportCommit(
  importId: string,
): Promise<PortfolioImportResult<{ status: PortfolioImportStatus; progress: PortfolioImportStageProgress[] }>> {
  const outcome = await fetchJson(`/api/portal/portfolio-import/${encodeURIComponent(importId)}/commit`);
  if (isFetchErr(outcome)) return outcome;
  const { res, payload } = outcome;
  if (!res.ok) return toErr(res, payload, "Could not check the import's progress.");
  return {
    ok: true,
    status: payload.status as PortfolioImportStatus,
    progress: (payload.progress as PortfolioImportStageProgress[] | undefined) ?? [],
  };
}

export async function invitePortfolioImportResidents(
  importId: string,
  residentKeys: string[],
  channels: PortfolioImportInviteChannel,
): Promise<PortfolioImportResult<{ results: PortfolioImportInviteResult[]; workNumber: string | null }>> {
  const outcome = await fetchJson(`/api/portal/portfolio-import/${encodeURIComponent(importId)}/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ residentKeys, channels }),
  });
  if (isFetchErr(outcome)) return outcome;
  const { res, payload } = outcome;
  if (!res.ok) return toErr(res, payload, "Could not send invites.");
  return {
    ok: true,
    results: (payload.results as PortfolioImportInviteResult[] | undefined) ?? [],
    workNumber: (payload.workNumber as string | null | undefined) ?? null,
  };
}

export async function listPortfolioImports(): Promise<PortfolioImportResult<{ imports: PortfolioImportSummary[] }>> {
  const outcome = await fetchJson("/api/portal/portfolio-import");
  if (isFetchErr(outcome)) return outcome;
  const { res, payload } = outcome;
  if (!res.ok) return toErr(res, payload, "Could not load your imports.");
  return { ok: true, imports: (payload.imports as PortfolioImportSummary[] | undefined) ?? [] };
}

/** Client-built CSV so "Download sample template" needs no server round trip. */
export function buildPortfolioImportSampleCsv(): string {
  const headers = [
    "Property",
    "Address",
    "City",
    "State",
    "Zip",
    "Unit",
    "Beds",
    "Baths",
    "Resident",
    "Email",
    "Phone",
    "Rent",
    "Deposit",
    "Lease start",
    "Lease end",
    "Balance",
  ];
  const rows = [
    [
      "Maple Court",
      "120 Maple St",
      "Austin",
      "TX",
      "78701",
      "1A",
      "2",
      "1",
      "Jordan Lee",
      "jordan.lee@example.com",
      "512-555-0100",
      "1850",
      "1850",
      "2026-01-01",
      "2026-12-31",
      "0",
    ],
    [
      "Maple Court",
      "120 Maple St",
      "Austin",
      "TX",
      "78701",
      "1B",
      "1",
      "1",
      "",
      "",
      "",
      "1400",
      "1400",
      "",
      "",
      "0",
    ],
  ];
  const escape = (cell: string) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);
  return [headers, ...rows].map((row) => row.map(escape).join(",")).join("\n");
}
