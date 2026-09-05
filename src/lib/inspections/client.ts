"use client";

import { createCoalescedRefresher } from "@/lib/coalesced-refresh";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { downloadBlobFile } from "@/lib/portal-document-download";
import type { InspectionResidency, InspectionRole, InspectionSummary } from "./model";

export type InspectionList = { reports: InspectionSummary[]; residencies: InspectionResidency[] };
export const INSPECTIONS_CHANGED = "proplane-inspections-changed";
export function inspectionUrl(role: InspectionRole, path = "") {
  return `/api/inspections${path}?portal=${role}`;
}
export async function inspectionRequest<T>(role: InspectionRole, path = "", init?: RequestInit): Promise<T> {
  if (isDemoModeActive()) throw new Error("Open your signed-in portal to save inspection records.");
  const response = await fetch(inspectionUrl(role, path), {
    ...init, headers: { ...(typeof init?.body === "string" ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Could not load inspections. Please try again.");
  if (init?.method && init.method !== "GET") {
    for (const entry of lists.values()) entry.expires = 0;
    window.dispatchEvent(new Event(INSPECTIONS_CHANGED));
  }
  return value as T;
}

type ListEntry = { value?: InspectionList; expires: number; refresher: ReturnType<typeof createCoalescedRefresher<InspectionList>> };
const lists = new Map<string, ListEntry>();
/** Identity + portal + residency isolate cached data. Forced post-write callers queue a fresh run. */
export async function loadInspectionList(userId: string, role: InspectionRole, applicationId?: string, force = false) {
  if (isDemoModeActive()) return { reports: [], residencies: [] } satisfies InspectionList;
  const key = JSON.stringify([userId, role, applicationId ?? ""]);
  let entry = lists.get(key);
  if (!entry) {
    if (lists.size > 50) lists.clear();
    const created: ListEntry = { expires: 0, refresher: createCoalescedRefresher(async () => {
      const response = await fetch(`${inspectionUrl(role)}${applicationId ? `&applicationId=${encodeURIComponent(applicationId)}` : ""}`);
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "Could not load inspections.");
      created.value = value as InspectionList;
      created.expires = Date.now() + 30_000;
      return created.value;
    }) };
    entry = created;
    lists.set(key, entry);
  }
  if (!force && entry.value && entry.expires > Date.now()) return entry.value;
  return entry.refresher.run(force);
}

export async function downloadInspection(role: InspectionRole, id: string) {
  if (isDemoModeActive()) throw new Error("Open your signed-in portal to download inspection records.");
  const response = await fetch(inspectionUrl(role, `/${id}/pdf`));
  if (!response.ok) {
    const value = await response.json();
    throw new Error(value.error || "Could not download this report.");
  }
  const result = await downloadBlobFile({ fileName: `inspection-${id}.pdf`, mimeType: "application/pdf", blob: await response.blob(), title: "Inspection report" });
  if (result === "failed") throw new Error("Could not save the PDF. Please try again.");
}
