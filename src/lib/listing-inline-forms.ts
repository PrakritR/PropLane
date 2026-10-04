/**
 * Pure edits behind the listing editor's inline Application and Lease steps (Add / Edit property).
 *
 * Nothing here has its own storage. Every function takes the listing submission (or its templates)
 * and returns the next one, so the wizard saves it the way it saves every other step.
 *
 *  - **Application fee** is never a template field. It is read from, and written to, the same
 *    placement fields the Pricing step edits and `listing-placement-standard-fees.ts` resolves:
 *    the room's long-term arrangement row (`applicationFee`), the room's Short term entry
 *    (`termPricing`), and the whole-house row. The server keeps resolving the amount; the client
 *    never hands it one.
 *  - **Needed / Offered** is `offered` on the application or lease template inside the listing
 *    submission JSON (absent = needed).
 *  - **Application <-> lease** is the one pipeline link, `linkedLeaseTemplateId` on the application
 *    (`application-lease-mapping.ts`). One application maps to one lease; one lease serves many
 *    applications. Both sides of the editor write that single field, so they cannot disagree.
 */
import {
  collapseApplicationLeaseLinks,
  isCosignerApplicationTemplate,
  leaseIdForApplication,
  leaseLinkFields,
  mappableApplicationTemplates,
  mappableLeaseTemplates,
} from "@/lib/application-lease-mapping";
import {
  applicationFeeRangeAcrossRooms,
  applicationFeeRangeLabel,
} from "@/lib/application-fee-by-room";
import { listingApplicationFeeRaw } from "@/lib/listing-application-fee";
import {
  mergeLongTermPrivateArrangementRow,
  mergeTermStandardFees,
} from "@/lib/listing-placement-standard-fees";
import {
  isEntireHomeListing,
  type ManagerCustomApplicationField,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { sanitizeMoneyInput } from "@/lib/listing-form-inputs";
import {
  applicationDraftReviewFingerprint,
  applicationFormVariantForTemplate,
  applicationTemplateQuestionConfigFromSlice,
  applicationTemplateQuestionPublishGate,
  createPropertyApplicationTemplate,
  draftQuestionConfigForTemplate,
  publishApplicationTemplateQuestionDraft,
  readPropertyApplicationTemplates,
  withPropertyApplicationTemplatesExplicit,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import {
  applicationConfigForVariant,
  customApplicationConfigWithAllStandardQuestions,
  mergeApplicationConfigForVariant,
  type ApplicationConfigSlice,
} from "@/lib/rental-application/application-field-catalog";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import type { RoomFeeTermScope } from "@/lib/room-term-fees";
import {
  addLeaseTemplateFromSeed,
  availableLeaseTemplateSeeds,
} from "@/lib/property-lease-template-sync";
import { submissionWithLeaseTemplates } from "@/lib/property-form-stay-type-routing";
import {
  createPropertyLeaseTemplate,
  makePropertyLeaseTemplateId,
  PROPERTY_LEASE_TYPE_OPTIONS,
  type PropertyLeaseTemplate,
} from "@/lib/property-lease-templates";

/* ───────────────────────────── names ───────────────────────────── */

/** `base`, or `base 2`, `base 3` ... the first one no other name uses (case-insensitive). */
export function uniqueFormLabel(taken: readonly string[], base: string): string {
  const used = new Set(taken.map((label) => label.trim().toLowerCase()));
  const root = base.trim() || "Untitled";
  if (!used.has(root.toLowerCase())) return root;
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${root} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${root} ${Date.now()}`;
}

/* ───────────────────────────── application fee ───────────────────────────── */

/** The stay scope an application's fee is priced under: a Short term form is "short", everything else "long". */
export function applicationFeeScopeForTemplate(
  template: Pick<PropertyApplicationTemplate, "kind" | "listingSeedKey" | "formVariant">,
): RoomFeeTermScope {
  if (template.listingSeedKey === "cosigner-short-term") return "short";
  return applicationFormVariantForTemplate(template) === "short_term" ? "short" : "long";
}

function dollarsText(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

export type ApplicationFeeInput = {
  /** What the box holds: the one amount every room resolves to, or "" when rooms differ or none is set. */
  value: string;
  /** "From $35" when rooms differ, so the box is not read as empty. */
  placeholder: string;
  varies: boolean;
};

/**
 * The fee box of an application row, read from the one resolver's inputs (never from the template).
 * Every room (or the whole house) resolving to the same amount shows that amount; differing rooms show
 * the range as the placeholder; with no room-level fee anywhere the listing-level fee is shown.
 */
export function readApplicationFeeInput(
  sub: ManagerListingSubmissionV1,
  scope: RoomFeeTermScope,
): ApplicationFeeInput {
  const range = applicationFeeRangeAcrossRooms(sub, scope);
  if (range) {
    if (range.minCents === range.maxCents) return { value: dollarsText(range.maxCents), placeholder: "", varies: false };
    return { value: "", placeholder: applicationFeeRangeLabel(range), varies: true };
  }
  const listing = listingApplicationFeeRaw(sub, scope === "short" ? "short_term" : "standard", null)
    .replace(/[^\d.]/g, "")
    .trim();
  return { value: listing, placeholder: "", varies: false };
}

/**
 * Types an application fee. It lands where the Pricing step keeps it, for that application's stay
 * type: every room's long-term arrangement row (`applicationFee`) or Short term entry
 * (`termPricing`), or the whole-house row. Blank clears the placement's own fee so it inherits again.
 */
export function withApplicationFee(
  sub: ManagerListingSubmissionV1,
  scope: RoomFeeTermScope,
  raw: string,
): ManagerListingSubmissionV1 {
  const value = sanitizeMoneyInput(raw);
  if (isEntireHomeListing(sub)) {
    const fees = { ...(sub.entireHomeArrangementFees ?? {}) } as NonNullable<ManagerListingSubmissionV1["entireHomeArrangementFees"]>;
    if (scope === "short") fees.shortTermApplicationFee = value;
    else fees.applicationFee = value;
    return { ...sub, entireHomeArrangementFees: fees, entireHomePriceSource: "own" };
  }
  return {
    ...sub,
    rooms: (sub.rooms ?? []).map((room) => {
      if (scope === "long") return mergeLongTermPrivateArrangementRow(room, { applicationFee: value });
      let next = mergeTermStandardFees(room, SHORT_TERM_LEASE_TERM, { applicationFee: value });
      // A stay fee saved before the per-stay entry existed lives on the long-term row; clearing must clear it too.
      if (value === "" && next.occupancyPrices?.some((row) => row.count === 1 && row.shortTermApplicationFee)) {
        next = {
          ...next,
          occupancyPrices: next.occupancyPrices.map((row) => (row.count === 1 ? { ...row, shortTermApplicationFee: "" } : row)),
        };
      }
      return next;
    }),
  };
}

/* ───────────────────────────── applications ───────────────────────────── */

/** Rewrites the property's applications (explicit, so a seeded default stays once edited). */
export function withApplicationTemplates(
  sub: ManagerListingSubmissionV1,
  templates: PropertyApplicationTemplate[],
): ManagerListingSubmissionV1 {
  return withPropertyApplicationTemplatesExplicit(sub, templates);
}

export function patchApplicationTemplate(
  templates: readonly PropertyApplicationTemplate[],
  id: string,
  patch: Partial<PropertyApplicationTemplate>,
): PropertyApplicationTemplate[] {
  const stamp = new Date().toISOString();
  return templates.map((row) => (row.id === id ? { ...row, ...patch, updatedAt: stamp } : row));
}

/** The question config the inline editor shows for a template (its draft, else the listing's legacy fields). */
export function questionSliceForTemplate(
  sub: ManagerListingSubmissionV1,
  template: PropertyApplicationTemplate,
): ApplicationConfigSlice {
  const variant = applicationFormVariantForTemplate(template);
  const draft = draftQuestionConfigForTemplate(template);
  const base = draft ? { ...sub, ...mergeApplicationConfigForVariant(variant, draft) } : sub;
  const slice = applicationConfigForVariant(base, variant);
  return { ...slice, questionDisplayOrder: draft?.questionDisplayOrder ?? slice.questionDisplayOrder };
}

/** Writes an edited question slice onto the template's DRAFT config (pinned custom, as the modal does for templates). */
export function withQuestionSlice(
  template: PropertyApplicationTemplate,
  slice: ApplicationConfigSlice,
): PropertyApplicationTemplate {
  const next: ApplicationConfigSlice = { ...slice, applicationConfigMode: "custom" };
  const previous = template.draftQuestionConfig ?? template.publishedQuestionConfig;
  return {
    ...template,
    draftQuestionConfig: {
      ...applicationTemplateQuestionConfigFromSlice(next, previous ?? undefined),
      questionDisplayOrder: next.questionDisplayOrder,
      disabledSectionIds: previous?.disabledSectionIds ? [...previous.disabledSectionIds] : undefined,
    },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * A new application, "started from" the PropLane standard questions or from an existing application.
 * Never a seeded default: it is the manager's own form.
 */
export function createInlineApplication(
  sub: ManagerListingSubmissionV1,
  templates: readonly PropertyApplicationTemplate[],
  startFrom: "proplane" | string,
  label?: string,
): PropertyApplicationTemplate {
  const source = startFrom === "proplane" ? null : templates.find((row) => row.id === startFrom) ?? null;
  const takenLabels = templates.map((row) => row.label);
  if (!source) {
    const created = createPropertyApplicationTemplate({
      kind: "long-term",
      label: uniqueFormLabel(takenLabels, label ?? "New application"),
    });
    return withQuestionSlice(created, customApplicationConfigWithAllStandardQuestions());
  }
  const created = createPropertyApplicationTemplate({
    kind: source.kind,
    label: uniqueFormLabel(takenLabels, label ?? `${source.label.trim() || "Application"} copy`),
    formVariant: applicationFormVariantForTemplate(source),
  });
  const copied = withQuestionSlice(created, questionSliceForTemplate(sub, source));
  const sourceDraft = draftQuestionConfigForTemplate(source);
  return {
    ...copied,
    draftQuestionConfig: copied.draftQuestionConfig
      ? { ...copied.draftQuestionConfig, disabledSectionIds: sourceDraft?.disabledSectionIds?.slice() }
      : copied.draftQuestionConfig,
    // A copy keeps the lease its original maps to; the manager can change it on the row.
    ...(isCosignerApplicationTemplate(source) ? {} : leaseLinkFields(source.linkedLeaseTemplateId ?? null)),
    tourOrder: source.tourOrder,
    offered: source.offered,
    // A copy applies to the same stays and keeps the original's co-signer form and fee; it never takes the
    // original's place as a stay's default (`defaultFor` is not copied).
    appliesTo: source.appliesTo,
    feeCentsOverride: source.feeCentsOverride,
    ...(isCosignerApplicationTemplate(source) ? {} : { linkedCosignerApplicationTemplateId: source.linkedCosignerApplicationTemplateId }),
  };
}

/**
 * Publishes every draft the inline editor left ahead of its published snapshot, so applicants see what
 * the manager just edited. One new version per edit session (the editor calls this when a row closes
 * and when the step unmounts), never one per keystroke. A draft that fails its publish gate (for
 * example an import with unresolved issues) stays a draft.
 */
export function publishPendingApplicationDrafts(
  sub: ManagerListingSubmissionV1,
  /** Drops blank option rows from custom questions, as the application editor does at Save. */
  sanitizeFields: (fields: ManagerCustomApplicationField[]) => ManagerCustomApplicationField[] = (fields) => fields,
): ManagerListingSubmissionV1 {
  const templates = readPropertyApplicationTemplates(sub);
  let changed = false;
  const next = templates.map((template) => {
    const rawDraft = template.draftQuestionConfig;
    if (!rawDraft) return template;
    const draft = { ...rawDraft, customApplicationFields: sanitizeFields(rawDraft.customApplicationFields) };
    const published = template.publishedQuestionConfig;
    if (published && applicationDraftReviewFingerprint(draft) === applicationDraftReviewFingerprint(published)) return template;
    const candidate = { ...template, draftQuestionConfig: draft };
    if (!applicationTemplateQuestionPublishGate(candidate).ok) return template;
    changed = true;
    return publishApplicationTemplateQuestionDraft(candidate);
  });
  return changed ? withPropertyApplicationTemplatesExplicit(sub, next) : sub;
}

/* ───────────────────── application <-> lease (one link, two views) ───────────────────── */

type Catalog = {
  applications: readonly PropertyApplicationTemplate[];
  leases: readonly PropertyLeaseTemplate[];
};

/** The lease an application leads to, or null. */
export function leaseOfApplication(catalog: Catalog, applicationId: string): string | null {
  return leaseIdForApplication(catalog, applicationId);
}

/** The applications that lead to a lease (the lease's view of the same link). */
export function applicationsOfLease(catalog: Catalog, leaseId: string): PropertyApplicationTemplate[] {
  return mappableApplicationTemplates(catalog.applications).filter(
    (application) => leaseIdForApplication(catalog, application.id) === leaseId,
  );
}

/** Application side: point one application at one lease (or none). */
export function linkApplicationToLease(
  catalog: Catalog,
  applicationId: string,
  leaseId: string | null,
): PropertyApplicationTemplate[] {
  return catalog.applications.map((application) =>
    application.id === applicationId && !isCosignerApplicationTemplate(application)
      ? { ...application, ...leaseLinkFields(leaseId), updatedAt: new Date().toISOString() }
      : application,
  );
}

/**
 * Lease side: the set of applications that lead to this lease. An application newly picked moves to
 * this lease (it can only ever lead to one); one unpicked is released.
 */
export function setApplicationsOfLease(
  catalog: Catalog,
  leaseId: string,
  applicationIds: readonly string[],
): PropertyApplicationTemplate[] {
  const picked = new Set(applicationIds);
  const stamp = new Date().toISOString();
  return catalog.applications.map((application) => {
    if (isCosignerApplicationTemplate(application)) return application;
    const current = leaseIdForApplication(catalog, application.id);
    if (picked.has(application.id)) {
      return current === leaseId ? application : { ...application, ...leaseLinkFields(leaseId), updatedAt: stamp };
    }
    return current === leaseId ? { ...application, ...leaseLinkFields(null), updatedAt: stamp } : application;
  });
}

/** Applications whose lease was deleted lose the dangling link. */
export function releaseDeletedLeaseLinks(
  applications: readonly PropertyApplicationTemplate[],
  remainingLeases: readonly PropertyLeaseTemplate[],
): PropertyApplicationTemplate[] {
  return collapseApplicationLeaseLinks(applications, remainingLeases).applications;
}

/** Leases an application may point at (never a co-signer addendum). */
export function leaseChoicesForApplication(leases: readonly PropertyLeaseTemplate[]): PropertyLeaseTemplate[] {
  return mappableLeaseTemplates(leases);
}

/* ───────────────────────────── leases ───────────────────────────── */

export type StandardLeaseKind = "long-term" | "short-term";

/**
 * Adds a PropLane standard lease. The first of a kind is the property's seeded default (it routes the
 * lease types the listing offers); a further one is the manager's own copy, unrouted until they pick.
 */
export function submissionWithStandardLease(
  sub: ManagerListingSubmissionV1,
  templates: readonly PropertyLeaseTemplate[],
  kind: StandardLeaseKind,
): { sub: ManagerListingSubmissionV1; leaseId: string } {
  const seedKey = kind === "short-term" ? "short-term" : "primary";
  const seed = availableLeaseTemplateSeeds({ ...sub, propertyLeaseTemplates: [...templates] } as ManagerListingSubmissionV1).find(
    (candidate) => candidate.seedKey === seedKey,
  );
  if (seed) {
    const next = addLeaseTemplateFromSeed({ ...sub, propertyLeaseTemplates: [...templates] } as ManagerListingSubmissionV1, seedKey);
    const created = next.propertyLeaseTemplates?.find((row) => row.listingSeedKey === seedKey);
    return { sub: next, leaseId: created?.id ?? "" };
  }
  const meta = PROPERTY_LEASE_TYPE_OPTIONS.find((option) => option.id === kind);
  const created = createPropertyLeaseTemplate({
    kind,
    label: uniqueFormLabel(templates.map((row) => row.label), meta?.defaultLabel ?? "Lease"),
    source: "axis_default",
  });
  return { sub: submissionWithLeaseTemplates(sub, [...templates, created]), leaseId: created.id };
}

/** A copy of a lease: the manager's own, never a seeded default and never inheriting the routed lease types. */
export function duplicateLeaseTemplate(
  templates: readonly PropertyLeaseTemplate[],
  id: string,
): PropertyLeaseTemplate | null {
  const source = templates.find((row) => row.id === id);
  if (!source) return null;
  const stamp = new Date().toISOString();
  return {
    ...source,
    id: makePropertyLeaseTemplateId(),
    label: uniqueFormLabel(templates.map((row) => row.label), `${source.label.trim() || "Lease"} copy`),
    listingSeedKey: undefined,
    applicationLeaseTerms: undefined,
    linkedApplicationTemplateId: null,
    leaseTemplateImportReview: undefined,
    libraryFormId: undefined,
    createdAt: stamp,
    updatedAt: stamp,
  };
}
