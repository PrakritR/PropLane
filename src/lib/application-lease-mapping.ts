/**
 * C2-CP9 — application <-> lease mapping, strictly one-to-one in the DEPENDENT direction.
 *
 * The workspace signing order (`leasing-pipeline-preferences.ts`) decides which side depends on
 * which:
 *
 * - Application first: every APPLICATION maps to exactly one LEASE
 *   (`PropertyApplicationTemplate.linkedLeaseTemplateId`). One lease may serve many applications;
 *   an application can never map to two leases.
 * - Lease first: every LEASE maps to exactly one APPLICATION
 *   (`PropertyLeaseTemplate.linkedApplicationTemplateId`). One application may serve many leases;
 *   a lease can never map to two applications.
 *
 * Each direction is stored as a single scalar on the dependent template, so a second link is
 * unrepresentable in new data. The only way to meet two is stored legacy data (the old
 * `usedForLeaseTemplateIds` array, or several leases that each named the same application); the
 * normaliser collapses those to ONE, deterministically (see `collapseApplicationLeaseLinks`).
 * Nothing here keeps two silently: a setter handed two targets refuses.
 *
 * Unmapped fallback (documented, deterministic):
 * - application -> lease: the property's default lease (`defaultLeaseTemplateId`) when it exists,
 *   else the kind/term based pick `resolvePropertyLeaseTemplateForApplication` has always made.
 * - lease -> application: the property's default application (`defaultApplicationTemplateId`) when
 *   it exists, else the first published template of the applicant's variant (today's pick).
 *
 * Pure, with type-only imports, so `manager-listing-submission.ts` can call the normaliser without
 * an import cycle.
 */
import type { PropertyApplicationTemplate } from "@/lib/property-application-templates";
import type { PropertyLeaseTemplate } from "@/lib/property-lease-templates";

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
 * Order of authority: the application's own `linkedLeaseTemplateId`; else (stored before this
 * field existed) the first lease, in catalog order, that named this application; else the first
 * lease in the application's legacy `usedForLeaseTemplateIds`.
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
  const pointing = catalog.leases.find((lease) => lease.linkedApplicationTemplateId?.trim() === id);
  if (pointing) return pointing.id;
  return cleanIds(application.usedForLeaseTemplateIds).find((leaseId) => leaseIds.has(leaseId)) ?? null;
}

/**
 * The ONE application a lease maps to, or null when unmapped.
 * Order of authority: the lease's own `linkedApplicationTemplateId`; else the first application,
 * in catalog order, whose legacy `usedForLeaseTemplateIds` named this lease.
 */
export function applicationIdForLease(catalog: MappingCatalog, leaseId: string | null | undefined): string | null {
  const id = leaseId?.trim();
  if (!id) return null;
  const lease = catalog.leases.find((candidate) => candidate.id === id);
  if (!lease) return null;
  const applicationIds = new Set(catalog.applications.map((application) => application.id));
  const explicit = lease.linkedApplicationTemplateId?.trim();
  if (explicit && applicationIds.has(explicit)) return explicit;
  return (
    catalog.applications.find(
      (application) => !isCosignerApplicationTemplate(application) && cleanIds(application.usedForLeaseTemplateIds).includes(id),
    )?.id ?? null
  );
}

/** The mapped target for a dependent row under `order`: application -> lease (app first) or lease -> application (lease first). */
export function mappedTargetId(
  order: MappingSigningOrder,
  catalog: MappingCatalog,
  dependentId: string,
): string | null {
  return order === "lease_then_application"
    ? applicationIdForLease(catalog, dependentId)
    : leaseIdForApplication(catalog, dependentId);
}

export type MappingEditResult =
  | { ok: true; applications: PropertyApplicationTemplate[]; leases: PropertyLeaseTemplate[] }
  | { ok: false; error: string };

/**
 * Point ONE dependent row at ONE target (or clear it with `null`). Handing it several targets is
 * refused, never truncated: an application can never map to two leases (application first) and a
 * lease can never map to two applications (lease first).
 */
export function setMappingTarget(
  order: MappingSigningOrder,
  catalog: MappingCatalog,
  dependentId: string,
  target: string | readonly string[] | null,
): MappingEditResult {
  const targets = target == null ? [] : typeof target === "string" ? [target] : cleanIds(target);
  const applicationFirst = order !== "lease_then_application";
  if (targets.length > 1) {
    return {
      ok: false,
      error: applicationFirst
        ? "An application can only use one lease."
        : "A lease can only use one application.",
    };
  }
  const targetId = targets[0]?.trim() || null;
  if (applicationFirst) {
    const application = catalog.applications.find((candidate) => candidate.id === dependentId);
    if (!application || isCosignerApplicationTemplate(application)) {
      return { ok: false, error: "That application cannot be mapped to a lease." };
    }
    if (targetId) {
      const lease = catalog.leases.find((candidate) => candidate.id === targetId);
      if (!lease || isAddendumLeaseTemplate(lease)) return { ok: false, error: "That lease is not available." };
    }
    return {
      ok: true,
      applications: catalog.applications.map((row) =>
        row.id === dependentId
          ? { ...row, linkedLeaseTemplateId: targetId, usedForLeaseTemplateIds: targetId ? [targetId] : undefined }
          : row,
      ),
      leases: [...catalog.leases],
    };
  }
  const lease = catalog.leases.find((candidate) => candidate.id === dependentId);
  if (!lease || isAddendumLeaseTemplate(lease)) return { ok: false, error: "That lease cannot be mapped to an application." };
  if (targetId) {
    const application = catalog.applications.find((candidate) => candidate.id === targetId);
    if (!application || isCosignerApplicationTemplate(application)) return { ok: false, error: "That application is not available." };
  }
  return {
    ok: true,
    // The lease's own link is now the answer; an application's legacy list must stop claiming this lease.
    applications: catalog.applications.map((row) =>
      cleanIds(row.usedForLeaseTemplateIds).includes(dependentId)
        ? { ...row, usedForLeaseTemplateIds: cleanIds(row.usedForLeaseTemplateIds).filter((id) => id !== dependentId) }
        : row,
    ),
    leases: catalog.leases.map((row) => (row.id === dependentId ? { ...row, linkedApplicationTemplateId: targetId } : row)),
  };
}

/**
 * Save-time normaliser. Guarantees, for any stored shape:
 * - every application's `linkedLeaseTemplateId` names an existing lease (a deleted lease releases it);
 * - every application carries AT MOST one lease, resolved by `leaseIdForApplication`'s order of
 *   authority (own link, then first lease naming it, then first legacy `usedForLeaseTemplateIds`),
 *   and the legacy array is rewritten to match that single id;
 * - every lease's `linkedApplicationTemplateId` names an existing application.
 * Returns the same arrays (by reference) when nothing changed.
 */
export function collapseApplicationLeaseLinks<
  A extends Pick<PropertyApplicationTemplate, "id" | "listingSeedKey" | "formVariant" | "linkedLeaseTemplateId" | "usedForLeaseTemplateIds">,
  L extends Pick<PropertyLeaseTemplate, "id" | "listingSeedKey" | "linkedApplicationTemplateId">,
>(applications: readonly A[], leases: readonly L[]): { applications: A[]; leases: L[]; changed: boolean } {
  const catalog = { applications, leases } as unknown as MappingCatalog;
  const applicationIds = new Set(applications.map((application) => application.id));
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
  const nextLeases = leases.map((lease) => {
    const link = lease.linkedApplicationTemplateId?.trim();
    if (!link || applicationIds.has(link)) return lease;
    changed = true;
    return { ...lease, linkedApplicationTemplateId: null };
  });
  return changed
    ? { applications: nextApplications, leases: nextLeases, changed }
    : { applications: applications as A[], leases: leases as L[], changed };
}

export type MappingViolation = { dependentId: string; targetIds: string[] };

/** Every dependent row that, as stored, names more than one target under `order`. Empty after `collapseApplicationLeaseLinks`. */
export function findMappingViolations(order: MappingSigningOrder, catalog: MappingCatalog): MappingViolation[] {
  if (order === "lease_then_application") return [];
  const out: MappingViolation[] = [];
  for (const application of mappableApplicationTemplates(catalog.applications)) {
    const targets = new Set<string>();
    const explicit = application.linkedLeaseTemplateId?.trim();
    if (explicit) targets.add(explicit);
    for (const lease of catalog.leases) if (lease.linkedApplicationTemplateId?.trim() === application.id) targets.add(lease.id);
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

/**
 * Resident path, lease first: the application a lease signer gets. Their lease's own mapping, else
 * the property default application, else null (the caller then keeps its first-published pick).
 */
export function resolveApplicationForLeaseTemplate(
  catalog: MappingCatalog,
  leaseTemplateId: string | null | undefined,
  defaultApplicationTemplateId?: string | null,
): PropertyApplicationTemplate | null {
  const mapped = applicationIdForLease(catalog, leaseTemplateId);
  const id = mapped ?? (defaultApplicationTemplateId?.trim() || null);
  const found = id ? catalog.applications.find((application) => application.id === id) : null;
  return found && !isCosignerApplicationTemplate(found) ? found : null;
}

export type MappingRow = {
  dependentId: string;
  dependentLabel: string;
  /** The one target this row maps to, or null when unmapped. */
  targetId: string | null;
  targetOptions: { value: string; label: string }[];
};

/**
 * What Settings -> Applications & leases draws: application first = one row per application with a
 * single Lease choice; lease first = one row per lease with a single Application choice.
 */
export function mappingRows(order: MappingSigningOrder, catalog: MappingCatalog): MappingRow[] {
  if (order === "lease_then_application") {
    const options = mappableApplicationTemplates(catalog.applications).map((a) => ({ value: a.id, label: a.label }));
    return mappableLeaseTemplates(catalog.leases).map((lease) => ({
      dependentId: lease.id,
      dependentLabel: lease.label,
      targetId: applicationIdForLease(catalog, lease.id),
      targetOptions: options,
    }));
  }
  const options = mappableLeaseTemplates(catalog.leases).map((l) => ({ value: l.id, label: l.label }));
  return mappableApplicationTemplates(catalog.applications).map((application) => ({
    dependentId: application.id,
    dependentLabel: application.label,
    targetId: leaseIdForApplication(catalog, application.id),
    targetOptions: options,
  }));
}
