/**
 * Browser side of the workspace Forms library (`leasing-forms-library.ts`): load and save the
 * library, read each property's own template lists from the local property store, and apply a
 * property's picks. Every write to a property goes through the same server-confirmed persist the
 * property tabs use; publishing an application copy goes through the same owner-scoped route the
 * application editor uses, so publication stays server-owned.
 */
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  persistManagerListingSubmissionOnServer,
  resolveManagerListingSubmissionForPropertyId,
} from "@/lib/manager-property-save-target";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import {
  applyPropertyFormPicks,
  normalizeLeasingFormsLibrary,
  propertyCopiesOfLibraryForm,
  syncLibraryFormIntoProperty,
  type LeasingFormKind,
  type LeasingFormsLibrary,
} from "@/lib/leasing-forms-library";
import type { PropertyApplicationTemplate } from "@/lib/property-application-templates";
import type { PropertyLeaseTemplate } from "@/lib/property-lease-templates";

export async function fetchLeasingFormsLibrary(): Promise<LeasingFormsLibrary> {
  const res = await fetch("/api/portal/leasing-forms", { credentials: "include", cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as { library?: unknown; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not load forms.");
  return normalizeLeasingFormsLibrary(data.library);
}

export async function putLeasingFormsLibrary(library: LeasingFormsLibrary): Promise<LeasingFormsLibrary> {
  const res = await fetch("/api/portal/leasing-forms", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ library }),
  });
  const data = (await res.json().catch(() => ({}))) as { library?: unknown; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not save forms.");
  return normalizeLeasingFormsLibrary(data.library);
}

export type LibraryProperty = { id: string; label: string; sub: ManagerListingSubmissionV1 };

/** The workspace's properties with their own template lists, read from the local property store. */
export function listLibraryProperties(userId: string | null): LibraryProperty[] {
  return buildManagerPropertyFilterOptions(userId).flatMap((option) => {
    const hit = resolveManagerListingSubmissionForPropertyId(userId, option.id);
    return hit ? [{ id: option.id, label: option.label, sub: hit.sub }] : [];
  });
}

async function publishApplicationCopy(propertyId: string, template: PropertyApplicationTemplate): Promise<string | null> {
  const res = await fetch("/api/portal/application-template-import", {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      propertyId,
      templateId: template.id,
      expectedPublishedVersion: template.publishedQuestionConfig?.version ?? 0,
    }),
  });
  if (res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? "Could not publish this application.";
}

export type PicksResult = { added: number; removed: number; draftOnly: number; failed: number };

/**
 * Set which library forms of one kind a property uses. A newly added application copy is published
 * for that property, so it goes live; when publishing is refused the copy stays a draft.
 */
export async function savePropertyPicks(input: {
  userId: string;
  propertyId: string;
  kind: LeasingFormKind;
  pickedIds: ReadonlySet<string>;
  library: LeasingFormsLibrary;
}): Promise<PicksResult> {
  const hit = resolveManagerListingSubmissionForPropertyId(input.userId, input.propertyId);
  if (!hit) return { added: 0, removed: 0, draftOnly: 0, failed: 1 };
  const applied = applyPropertyFormPicks(hit.sub, input.kind, input.pickedIds, input.library);
  if (applied.added === 0 && applied.removed === 0) return { added: 0, removed: 0, draftOnly: 0, failed: 0 };
  const saved = await persistManagerListingSubmissionOnServer(hit.saveTarget, input.userId, applied.sub);
  if (!saved) return { added: 0, removed: 0, draftOnly: 0, failed: 1 };
  let draftOnly = 0;
  if (input.kind === "application") {
    const copies = propertyCopiesOfLibraryFormIds(applied.sub, applied.addedApplicationIds);
    for (const copy of copies) {
      if (await publishApplicationCopy(hit.saveTarget.saveId, copy)) draftOnly += 1;
    }
  }
  return { added: applied.added, removed: applied.removed, draftOnly, failed: 0 };
}

function propertyCopiesOfLibraryFormIds(sub: ManagerListingSubmissionV1, ids: string[]): PropertyApplicationTemplate[] {
  const wanted = new Set(ids);
  return (sub.propertyApplicationTemplates ?? []).filter((row) => wanted.has(row.id));
}

/**
 * After a library form is edited, bring every property copy of it up to date. A copy that was live
 * is published again so the change reaches applicants; one that was never published stays a draft.
 */
export async function pushLibraryFormToProperties(input: {
  userId: string;
  kind: LeasingFormKind;
  form: PropertyApplicationTemplate | PropertyLeaseTemplate;
  propertyIds: string[];
}): Promise<{ updated: number; failed: number }> {
  let updated = 0;
  let failed = 0;
  for (const propertyId of input.propertyIds) {
    const hit = resolveManagerListingSubmissionForPropertyId(input.userId, propertyId);
    if (!hit) continue;
    const copies = input.kind === "application" ? propertyCopiesOfLibraryForm(hit.sub, input.form.id) : [];
    const isLinked =
      input.kind === "application"
        ? copies.length > 0
        : (hit.sub.propertyLeaseTemplates ?? []).some((row) => row.libraryFormId === input.form.id);
    if (!isLinked) continue;
    const next = syncLibraryFormIntoProperty(hit.sub, input.kind, input.form);
    if (!(await persistManagerListingSubmissionOnServer(hit.saveTarget, input.userId, next))) {
      failed += 1;
      continue;
    }
    let ok = true;
    for (const copy of copies.filter((row) => row.publishedQuestionConfig)) {
      if (await publishApplicationCopy(hit.saveTarget.saveId, copy)) ok = false;
    }
    if (ok) updated += 1;
    else failed += 1;
  }
  if (updated > 0 || failed > 0) await syncPropertyPipelineFromServer({ force: true }).catch(() => undefined);
  return { updated, failed };
}
