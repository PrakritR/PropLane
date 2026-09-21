/**
 * Browser side of the rebuilt portfolio import — typed fetch helpers over
 * `/api/portal/portfolio-import*`. Every call resolves to `{ ok: true, … }`
 * or `{ ok: false, status, error }`; nothing here throws a raw error, so
 * callers never need a try/catch around a network hiccup.
 *
 * The server owns reading, understanding, and staging the proposal
 * (`src/lib/portfolio-import/types.ts`); this file only shapes requests and
 * responses. A 4xx error's server message is shown to the manager as-is; a
 * 5xx always reads "PropLane could not read the files." so a stack trace
 * never reaches the screen.
 */

import type {
  PortfolioImportCreateRequest,
  PortfolioImportCreateResult,
  PortfolioImportProposal,
  PortfolioImportUpdateRequest,
} from "@/lib/portfolio-import/types";

export type PortfolioImportErr = { ok: false; status: number; error: string };
export type PortfolioImportResult<T> = ({ ok: true } & T) | PortfolioImportErr;

const NETWORK_ERROR = "Could not reach the server. Check your connection and try again.";
const SERVER_ERROR = "PropLane could not read the files.";

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function errorFor(res: Response, payload: Record<string, unknown>): PortfolioImportErr {
  const message = typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : null;
  if (res.status >= 500) return { ok: false, status: res.status, error: SERVER_ERROR };
  return { ok: false, status: res.status, error: message ?? "That request failed." };
}

async function request(input: string, init?: RequestInit): Promise<{ res: Response; payload: Record<string, unknown> } | PortfolioImportErr> {
  let res: Response;
  try {
    res = await fetch(input, { credentials: "include", ...init });
  } catch {
    return { ok: false, status: 0, error: NETWORK_ERROR };
  }
  const payload = await readJson(res);
  if (!res.ok) return errorFor(res, payload);
  return { res, payload };
}

function isErr(x: { res: Response; payload: Record<string, unknown> } | PortfolioImportErr): x is PortfolioImportErr {
  return "ok" in x && x.ok === false;
}

/** Posts the picked files (+ optional hint) and returns the read proposal. */
export async function uploadPortfolioImport(
  files: File[],
  hint?: string,
): Promise<PortfolioImportResult<{ proposal: PortfolioImportProposal }>> {
  const form = new FormData();
  for (const file of files) form.append("files[]", file, file.name);
  if (hint?.trim()) form.append("hint", hint.trim());
  const outcome = await request("/api/portal/portfolio-import", { method: "POST", body: form });
  if (isErr(outcome)) return outcome;
  return { ok: true, proposal: outcome.payload as unknown as PortfolioImportProposal };
}

export async function getPortfolioImport(importId: string): Promise<PortfolioImportResult<{ proposal: PortfolioImportProposal }>> {
  const outcome = await request(`/api/portal/portfolio-import/${encodeURIComponent(importId)}`);
  if (isErr(outcome)) return outcome;
  return { ok: true, proposal: outcome.payload as unknown as PortfolioImportProposal };
}

/** Saves gap answers and/or skip marks; the server returns the recomputed proposal. */
export async function patchPortfolioImport(
  importId: string,
  body: PortfolioImportUpdateRequest,
): Promise<PortfolioImportResult<{ proposal: PortfolioImportProposal }>> {
  const outcome = await request(`/api/portal/portfolio-import/${encodeURIComponent(importId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (isErr(outcome)) return outcome;
  return { ok: true, proposal: outcome.payload as unknown as PortfolioImportProposal };
}

export async function createFromPortfolioImport(
  importId: string,
  body: PortfolioImportCreateRequest,
): Promise<PortfolioImportResult<{ result: PortfolioImportCreateResult }>> {
  const outcome = await request(`/api/portal/portfolio-import/${encodeURIComponent(importId)}/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (isErr(outcome)) return outcome;
  return { ok: true, result: outcome.payload as unknown as PortfolioImportCreateResult };
}
