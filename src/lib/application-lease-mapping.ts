/**
 * C2-CP9 — application -> lease mapping, strictly one-to-one in the dependent direction.
 *
 * Every workspace is application first, then lease, then the move-in form (captain, Oct 3 2026).
 * Every APPLICATION maps to exactly one LEASE (`PropertyApplicationTemplate.linkedLeaseTemplateId`).
 * One lease may serve many applications; an application can never map to two leases. The old
 * lease -> application direction (lease first) is gone: nothing here reads or writes
 * `PropertyLeaseTemplate.linkedApplicationTemplateId` any more, so a stored value is simply inert.
 *
 * The link is a single scalar on the application, so a second link is unrepresentable in new data.
 * The only way to meet two is stored legacy data (the old `usedForLeaseTemplateIds` array); the
 * normaliser collapses those to ONE, deterministically (see `collapseApplicationLeaseLinks`).
 * Nothing here keeps two silently: a setter handed two targets refuses.
 *
 * Unmapped fallback: the property's default lease (`defaultLeaseTemplateId`) when it exists, else
 * the kind/term based pick `resolvePropertyLeaseTemplateForApplication` has always made.
 *
 * Pure, with type-only imports, so `manager-listing-submission.ts` can call the normaliser without
 * an import cycle.
 */
import type { PropertyApplicationTemplate } from "@/lib/property-application-templates";
import type { PropertyLeaseTemplate } from "@/lib/property-lease-templates";

/** Kept as a type so call sites compile; only `application_then_lease` is ever honoured. */
export type MappingSigningOrder = "application_then_lease" | "lease_then_application";

export type MappingCatalog = {
  applications: readonly PropertyApplicationTemplate[];
  leases: readonly PropertyLeaseTemplate[];
};

/** Co-signer forms and co-signer / guarantor addenda ride along with a main form; they are never mapped on their own. */
export function isCosignerApplicationTemplate(
  template: Pick<PropertyApplicationTemplate, "listingSeedKey" | "formVariant">,
): boolean {
  return (
    template.formVariant === "cosigner" ||
    template.listingSeedKey === "cosigner" ||
    template.listingSeedKey === "cosigner-short-term"
  );
}

export function isAddendumLeaseTemplate(template: Pick<PropertyLeaseTemplate, "listingSeedKey">): boolean {
  return template.listingSeedKey === "cosigner" || template.listingSeedKey === "cosigner-short-term";
}

export function mappableApplicationTemplates<T extends Pick<PropertyApplicationTemplate, "listingSeedKey" | "formVariant">>(
  applications: readonly T[],
): T[] {
  return applications.filter((template) => !isCosignerApplicationTemplate(template));
}

export function mappableLeaseTemplates<T extends Pick<PropertyLeaseTemplate, "listingSeedKey">>(
  leases: readonly T[],
): T[] {
  return leases.filter((template) => !isAddendumLeaseTemplate(template));
}

function cleanIds(ids: readonly string[] | null | undefined): string[] {
  return [...new Set((ids ?? []).filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim()))];
}

/**
 * The ONE lease an application maps to, or null when unmapped.
 * Order of authority: the application's own `linkedLeaseTemplateId`; else the first lease in the
 * application's legacy `usedForLeaseTemplateIds`.
 */
export function leaseIdForApplication(catalog: MappingCatalog, applicationId: string | null | undefined): string | null {
  const id = applicationId?.trim();
  if (!id) return null;
  const application = catalog.applications.find((candidate) => candidate.id === id);
  if (!application) return null;
  const leaseIds = new Set(catalog.leases.map((lease) => lease.id));
  // An explicit `null` is the manager choosing "no lease": it outranks every legacy derivation.
  if (application.linkedLeaseTemplateId === null) return null;
  const explicit = application.linkedLeaseTemplateId?.trim();
  if (explicit && leaseIds.has(explicit)) return explicit;
  return cleanIds(application.usedForLeaseTemplateIds).find((leaseId) => leaseIds.has(leaseId)) ?? null;
}

/**
 * @deprecated Lease first is retired: a lease maps to no application. Always null. Kept only so
 * `property-lease-form-modal.tsx` (a separately owned file) still compiles until it drops the import.
 */
export function applicationIdForLease(_catalog: MappingCatalog, _leaseId: string | null | undefined): string | null {
  return null;
}

/** The lease an application maps to (the only direction). */
export function mappedTargetId(
  _order: MappingSigningOrder,
  catalog: MappingCatalog,
  dependentId: string,
): string | null {
  return leaseIdForApplication(catalog, dependentId);
}

export type MappingEditResult =
  | { ok: true; applications: PropertyApplicationTemplate[]; leases: PropertyLeaseTemplate[] }
  | { ok: false; error: string };

/** Why `targetId` cannot be chosen as an application's lease (null = it can). */
export function mappingTargetError(
  _order: MappingSigningOrder,
  catalog: MappingCatalog,
  targetId: string | null,
): string | null {
  if (!targetId) return null;
  const lease = catalog.leases.find((candidate) => candidate.id === targetId);
  return !lease || isAddendumLeaseTemplate(lease) ? "That lease is not available." : null;
}

/** The two scalar fields an application stores for its ONE lease (application first). */
export function leaseLinkFields(targetId: string | null): Pick<PropertyApplicationTemplate, "linkedLeaseTemplateId" | "usedForLeaseTemplateIds"> {
  return { linkedLeaseTemplateId: targetId, usedForLeaseTemplateIds: targetId ? [targetId] : undefined };
}

/**
 * @deprecated Lease first is retired. Always clears the link. Kept only so
 * `property-lease-form-modal.tsx` (a separately owned file) still compiles until it drops the import.
 */
export function applicationLinkForLease(
  _catalog: MappingCatalog,
  _leaseId: string,
  _target: string | readonly string[] | null,
):
  | { ok: true; linkedApplicationTemplateId: string | null; applications: PropertyApplicationTemplate[] | null }
  | { ok: false; error: string } {
  return { ok: true, linkedApplicationTemplateId: null, applications: null };
}

/**
 * Point ONE application at ONE lease (or clear it with `null`). Handing it several targets is
 * refused, never truncated: an application can never map to two leases.
 */
export function setMappingTarget(
  order: MappingSigningOrder,
  catalog: MappingCatalog,
  dependentId: string,
  target: string | readonly string[] | null,
): MappingEditResult {
  const targets = target == null ? [] : typeof target === "string" ? [target] : cleanIds(target);
  if (targets.length > 1) return { ok: false, error: "An application can only use one lease." };
  const targetId = targets[0]?.trim() || null;
  const application = catalog.applications.find((candidate) => candidate.id === dependentId);
  if (!application || isCosignerApplicationTemplate(application)) {
    return { ok: false, error: "That application cannot be mapped to a lease." };
  }
  const error = mappingTargetError(order, catalog, targetId);
  if (error) return { ok: false, error };
  return {
    ok: true,
    applications: catalog.applications.map((row) => (row.id === dependentId ? { ...row, ...leaseLinkFields(targetId) } : row)),
    leases: [...catalog.leases],
  };
}

/**
 * Save-time normaliser. Guarantees, for any stored shape:
 * - every application's `linkedLeaseTemplateId` names an existing lease (a deleted lease releases it);
 * - every application carries AT MOST one lease, resolved by `leaseIdForApplication`'s order of
 *   authority (own link, then first lease naming it, then first legacy `usedForLeaseTemplateIds`),
 *   and the legacy array is rewritten to match that single id;
 * Leases are returned untouched (a stored lease -> application link is inert and left alone).
 * Returns the same arrays (by reference) when nothing changed.
 */
export function collapseApplicationLeaseLinks<
  A extends Pick<PropertyApplicationTemplate, "id" | "listingSeedKey" | "formVariant" | "linkedLeaseTemplateId" | "usedForLeaseTemplateIds">,
  L extends Pick<PropertyLeaseTemplate, "id" | "listingSeedKey">,
>(applications: readonly A[], leases: readonly L[]): { applications: A[]; leases: L[]; changed: boolean } {
  const catalog = { applications, leases } as unknown as MappingCatalog;
  let changed = false;
  const nextApplications = applications.map((application) => {
    if (isCosignerApplicationTemplate(application)) return application;
    const resolved = leaseIdForApplication(catalog, application.id);
    const legacy = cleanIds(application.usedForLeaseTemplateIds);
    const sameLegacy = resolved ? legacy.length === 1 && legacy[0] === resolved : legacy.length === 0;
    const sameLink = (application.linkedLeaseTemplateId?.trim() || null) === resolved;
    if (sameLegacy && sameLink) return application;
    // An application that never had either field stays untouched (no needless `null` writes).
    if (!resolved && !application.linkedLeaseTemplateId && legacy.length === 0) return application;
    changed = true;
    return {
      ...application,
      linkedLeaseTemplateId: resolved,
      usedForLeaseTemplateIds: resolved ? [resolved] : undefined,
    };
  });
  return changed
    ? { applications: nextApplications, leases: leases as L[], changed }
    : { applications: applications as A[], leases: leases as L[], changed };
}

export type MappingViolation = { dependentId: string; targetIds: string[] };

/** Every dependent row that, as stored, names more than one target as an application's leases. Empty after `collapseApplicationLeaseLinks`. */
export function findMappingViolations(_order: MappingSigningOrder, catalog: MappingCatalog): MappingViolation[] {
  const out: MappingViolation[] = [];
  for (const application of mappableApplicationTemplates(catalog.applications)) {
    const targets = new Set<string>();
    const explicit = application.linkedLeaseTemplateId?.trim();
    if (explicit) targets.add(explicit);
    for (const id of cleanIds(application.usedForLeaseTemplateIds)) targets.add(id);
    if (targets.size > 1) out.push({ dependentId: application.id, targetIds: [...targets] });
  }
  return out;
}

/**
 * Resident path, application first: the lease an applicant gets. Their application's own mapping,
 * else the property default lease, else null (the caller then keeps its kind/term based pick).
 */
export function resolveLeaseForApplicationTemplate(
  catalog: MappingCatalog,
  applicationTemplateId: string | null | undefined,
  defaultLeaseTemplateId?: string | null,
): PropertyLeaseTemplate | null {
  const mapped = leaseIdForApplication(catalog, applicationTemplateId);
  const id = mapped ?? (defaultLeaseTemplateId?.trim() || null);
  return (id ? catalog.leases.find((lease) => lease.id === id) : null) ?? null;
}

export type MappingRow = {
  dependentId: string;
  dependentLabel: string;
  /** The one target this row maps to, or null when unmapped. */
  targetId: string | null;
  targetOptions: { value: string; label: string }[];
};

/** One row per application with a single Lease choice (application first, the only order). */
export function mappingRows(_order: MappingSigningOrder, catalog: MappingCatalog): MappingRow[] {
  const options = mappableLeaseTemplates(catalog.leases).map((l) => ({ value: l.id, label: l.label }));
  return mappableApplicationTemplates(catalog.applications).map((application) => ({
    dependentId: application.id,
    dependentLabel: application.label,
    targetId: leaseIdForApplication(catalog, application.id),
    targetOptions: options,
  }));
}
