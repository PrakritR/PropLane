"use client";

/**
 * Browser half of the move-in forms contract (see `types.ts`). Every call goes through the
 * one catch-all route, `/api/move-in-forms/[[...path]]`, with `?portal=manager|resident`,
 * the same shape as inspections. The server re-derives every scope; ids here are requests only.
 */
import { createCoalescedRefresher } from "@/lib/coalesced-refresh";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { downloadBlobFile } from "@/lib/portal-document-download";
import { fitImageForUpload } from "./fit-image";
import type { MoveInFormAnswer, MoveInFormRecord, MoveInFormSummary, MoveInFormTemplate } from "./types";

export type MoveInFormPortal = "manager" | "resident";
export type MoveInFormList = { forms: MoveInFormSummary[]; unread: number };
export const MOVE_IN_FORMS_CHANGED = "proplane-move-in-forms-changed";

export function moveInFormUrl(portal: MoveInFormPortal, path = "", query: Record<string, string | undefined> = {}) {
  const params = new URLSearchParams({ portal });
  for (const [k, v] of Object.entries(query)) if (v) params.set(k, v);
  return `/api/move-in-forms${path}?${params.toString()}`;
}

/**
 * `quiet` writes (an autosaved draft, a photo upload or removal) change nothing a list shows, so they
 * neither clear the list cache nor broadcast `MOVE_IN_FORMS_CHANGED`; only send, remind, cancel and
 * submit do. Otherwise every debounced keystroke pause would refetch the resident's whole form list.
 */
export async function moveInFormRequest<T>(
  portal: MoveInFormPortal,
  path = "",
  init?: RequestInit,
  options: { quiet?: boolean; query?: Record<string, string | undefined> } = {},
): Promise<T> {
  if (isDemoModeActive()) throw new Error("Open your signed-in portal to use move-in forms.");
  const isJson = typeof init?.body === "string";
  const response = await fetch(moveInFormUrl(portal, path, options.query), {
    ...init,
    headers: { ...(isJson ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((value as { error?: string }).error || "Could not load move-in forms. Please try again.");
  if (init?.method && init.method !== "GET" && !options.quiet) {
    for (const entry of lists.values()) entry.expires = 0;
    window.dispatchEvent(new Event(MOVE_IN_FORMS_CHANGED));
  }
  return value as T;
}

type ListQuery = { status?: "submitted" | "sent"; propertyId?: string; applicationId?: string };
type ListEntry = { value?: MoveInFormList; expires: number; refresher: ReturnType<typeof createCoalescedRefresher<MoveInFormList>> };
const lists = new Map<string, ListEntry>();

/** Keyed on viewer + portal + filters so two different lists never share a cached answer. */
export async function loadMoveInForms(userId: string, portal: MoveInFormPortal, query: ListQuery = {}, force = false): Promise<MoveInFormList> {
  if (isDemoModeActive()) return { forms: [], unread: 0 };
  const key = JSON.stringify([userId, portal, query.status ?? "", query.propertyId ?? "", query.applicationId ?? ""]);
  let entry = lists.get(key);
  if (!entry) {
    if (lists.size > 50) lists.clear();
    const created: ListEntry = {
      expires: 0,
      refresher: createCoalescedRefresher(async () => {
        const path = portal === "resident" ? "/mine" : "";
        const response = await fetch(moveInFormUrl(portal, path, query));
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || "Could not load move-in forms.");
        created.value = value as MoveInFormList;
        created.expires = Date.now() + 30_000;
        return created.value;
      }),
    };
    entry = created;
    lists.set(key, entry);
  }
  if (!force && entry.value && entry.expires > Date.now()) return entry.value;
  return entry.refresher.run(force);
}

/* ---------------- manager ---------------- */
export const getMoveInForm = (id: string) =>
  moveInFormRequest<{ form: MoveInFormRecord }>("manager", `/${encodeURIComponent(id)}`);
export const sendMoveInForm = (input: { applicationId: string; formId: string; dueAt?: string }) =>
  moveInFormRequest<{ form: MoveInFormSummary }>("manager", "/send", { method: "POST", body: JSON.stringify(input) });
/** "Already-signed residents: send now too" — sends one form to every current signed residency it applies to. */
export const sendMoveInFormToCurrentResidents = (input: { propertyId: string; formId: string }) =>
  moveInFormRequest<{ sent: number }>("manager", "/send-existing", { method: "POST", body: JSON.stringify(input) });
export const remindMoveInForm =(id: string) =>
  moveInFormRequest<{ ok: true }>("manager", `/${encodeURIComponent(id)}/remind`, { method: "POST", body: "{}" });
export const cancelMoveInForm = (id: string) =>
  moveInFormRequest<{ ok: true }>("manager", `/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" });

/** Uploads a template PDF for one property's form; returns the metadata to store on the template. */
export async function uploadMoveInFormPdf(propertyId: string, formId: string, file: File) {
  const data = new FormData();
  data.set("propertyId", propertyId);
  data.set("formId", formId);
  data.set("file", file);
  return moveInFormRequest<{ pdf: NonNullable<MoveInFormTemplate["pdf"]> }>("manager", "/template-pdf", { method: "POST", body: data });
}

/* ---------------- resident ---------------- */
export const getMyMoveInForm = (id: string) =>
  moveInFormRequest<{ form: MoveInFormRecord }>("resident", `/mine/${encodeURIComponent(id)}`);
export const saveMyMoveInFormDraft = (id: string, answers: MoveInFormAnswer[]) =>
  moveInFormRequest<{ form: MoveInFormRecord }>("resident", `/mine/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ answers }) }, { quiet: true });
export async function uploadMyMoveInFormFile(id: string, questionKey: string, file: Blob, fileName: string) {
  // A body over the host's 4.5 MB cap never arrives: shrink a big photo first, or say plainly it cannot go.
  const fitted = await fitImageForUpload(file);
  const data = new FormData();
  data.set("questionKey", questionKey);
  data.set("file", fitted.blob, fitted.resized ? fileName.replace(/\.[^./\\]+$/, "") + ".jpg" : fileName);
  return moveInFormRequest<{ storagePath: string }>("resident", `/mine/${encodeURIComponent(id)}/files`, { method: "POST", body: data }, { quiet: true });
}
/** Removes a photo or signature the resident uploaded and then took out of their answers. */
export const deleteMyMoveInFormFile = (id: string, storagePath: string) =>
  moveInFormRequest<{ ok: true }>("resident", `/mine/${encodeURIComponent(id)}/files`, { method: "DELETE" }, { quiet: true, query: { path: storagePath } });
export const submitMyMoveInForm = (id: string, answers: MoveInFormAnswer[]) =>
  moveInFormRequest<{ form: MoveInFormRecord }>("resident", `/mine/${encodeURIComponent(id)}/submit`, { method: "POST", body: JSON.stringify({ answers }) });

/* ---------------- both ---------------- */
/** Template PDF bytes (the resident only for a form actually sent to them). */
export const moveInFormTemplatePdfUrl = (portal: MoveInFormPortal, recordOrFormId: string, propertyId?: string) =>
  moveInFormUrl(portal, portal === "resident" ? `/mine/${encodeURIComponent(recordOrFormId)}/template-pdf` : "/template-pdf", portal === "manager" ? { formId: recordOrFormId, propertyId } : {});
/** A stored photo or signature, through a server-minted signed URL after an ownership check. */
export const moveInFormFileUrl = (portal: MoveInFormPortal, id: string, storagePath: string) =>
  moveInFormUrl(portal, portal === "resident" ? `/mine/${encodeURIComponent(id)}/file` : `/${encodeURIComponent(id)}/file`, { path: storagePath });

export async function downloadMoveInFormPdf(portal: MoveInFormPortal, id: string, fileName: string) {
  if (isDemoModeActive()) throw new Error("Open your signed-in portal to download move-in forms.");
  const path = portal === "resident" ? `/mine/${encodeURIComponent(id)}/pdf` : `/${encodeURIComponent(id)}/pdf`;
  const response = await fetch(moveInFormUrl(portal, path));
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new Error((value as { error?: string }).error || "Could not download this form.");
  }
  const result = await downloadBlobFile({ fileName, mimeType: "application/pdf", blob: await response.blob(), title: "Move-in form" });
  if (result === "failed") throw new Error("Could not save the PDF. Please try again.");
}
