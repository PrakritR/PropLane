/**
 * Workspace-wide rental application template. A manager configures this ONCE
 * (Settings → Application form) and every listing follows it by default,
 * using the SAME model a per-listing custom application already uses
 * (`ManagerCustomApplicationField[]` + `disabledStandardApplicationKeys` +
 * an `applicationConfigMode`), just stored at the workspace instead of the
 * listing. A listing may still opt into its own independent copy
 * (`applicationFormSource: "custom"` on `ManagerListingSubmissionV1`).
 *
 * `resolveEffectiveApplicationForm` is the ONE function every reader of "what
 * question set applies to this listing" goes through: `publicListingProjection`
 * (`public-listings.server.ts`) bakes its result into the public payload once,
 * server-side validation (`validate-application-submit.server.ts`) resolves it
 * independently against a freshly-loaded listing + workspace row, and the
 * listing wizard's own preview (`pro-application-questions-editor-modal.tsx`)
 * calls it to show the manager what "Workspace form" currently resolves to.
 * See `docs/agents/listing-wizard-defaults.md` for why this is a LIVE
 * resolution rather than a one-time snapshot copied onto the listing: unlike
 * a Rooms/Bathrooms "Default card" (removed because each record's own values
 * are independent data with no live link), the workspace form here is an
 * explicit, persisted, manager-visible mode (`applicationFormSource`), not a
 * value-equality inference — the same live workspace→property resolution
 * pattern `src/lib/settings/scope-resolver.server.ts` already uses for
 * automation settings. Switching a listing TO "custom" still does a one-time
 * copy (mirrors the "Same as Room X" pattern) so editing afterward is
 * independent.
 */

import {
  normalizeCustomApplicationFields,
  type ManagerCustomApplicationField,
} from "@/lib/manager-listing-submission";

/** The application-config triplet, stored once per variant on the workspace template. */
export type WorkspaceApplicationFormVariantSlice = {
  customApplicationFields: ManagerCustomApplicationField[];
  disabledStandardApplicationKeys: string[];
  applicationConfigMode: "standard" | "custom";
};

/**
 * Workspace-level rental application template. Mirrors the long-term +
 * short-term + cosigner triplet a listing already carries. When
 * `shareAcrossVariants` is true, the editor mirrors the long-term
 * (`customApplicationFields` etc.) list onto the short-term and cosigner
 * slots on every save (`applyShareAcrossVariants`), so a manager maintains
 * one list; unticking it leaves the three lists independently editable,
 * exactly like a listing's own arrays work today.
 */
export type WorkspaceApplicationFormTemplate = {
  customApplicationFields: ManagerCustomApplicationField[];
  disabledStandardApplicationKeys: string[];
  applicationConfigMode: "standard" | "custom";
  shortTermCustomApplicationFields: ManagerCustomApplicationField[];
  shortTermDisabledStandardApplicationKeys: string[];
  shortTermApplicationConfigMode: "standard" | "custom";
  cosignerCustomApplicationFields: ManagerCustomApplicationField[];
  cosignerDisabledStandardApplicationKeys: string[];
  cosignerApplicationConfigMode: "standard" | "custom";
  /** "Use the main questions for short-term and cosigner applications too." Default true for a new form. */
  shareAcrossVariants: boolean;
  updatedAt?: string;
};

export function emptyWorkspaceApplicationFormTemplate(): WorkspaceApplicationFormTemplate {
  return {
    customApplicationFields: [],
    disabledStandardApplicationKeys: [],
    applicationConfigMode: "standard",
    shortTermCustomApplicationFields: [],
    shortTermDisabledStandardApplicationKeys: [],
    shortTermApplicationConfigMode: "standard",
    cosignerCustomApplicationFields: [],
    cosignerDisabledStandardApplicationKeys: [],
    cosignerApplicationConfigMode: "standard",
    shareAcrossVariants: true,
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
}

function asConfigMode(value: unknown): "standard" | "custom" {
  return value === "custom" ? "custom" : "standard";
}

/** When true, mirror the long-term list onto the short-term/cosigner slots so a manager edits one list. */
export function applyShareAcrossVariants(template: WorkspaceApplicationFormTemplate): WorkspaceApplicationFormTemplate {
  if (!template.shareAcrossVariants) return template;
  return {
    ...template,
    shortTermCustomApplicationFields: template.customApplicationFields,
    shortTermDisabledStandardApplicationKeys: template.disabledStandardApplicationKeys,
    shortTermApplicationConfigMode: template.applicationConfigMode,
    cosignerCustomApplicationFields: template.customApplicationFields,
    cosignerDisabledStandardApplicationKeys: template.disabledStandardApplicationKeys,
    cosignerApplicationConfigMode: template.applicationConfigMode,
  };
}

/** Coerce a persisted `row_data.applicationFormTemplate` blob into a clean template, or null when never saved. */
export function normalizeWorkspaceApplicationFormTemplate(raw: unknown): WorkspaceApplicationFormTemplate | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const template: WorkspaceApplicationFormTemplate = {
    customApplicationFields: normalizeCustomApplicationFields(o.customApplicationFields),
    disabledStandardApplicationKeys: asStringArray(o.disabledStandardApplicationKeys),
    applicationConfigMode: asConfigMode(o.applicationConfigMode),
    shortTermCustomApplicationFields: normalizeCustomApplicationFields(o.shortTermCustomApplicationFields),
    shortTermDisabledStandardApplicationKeys: asStringArray(o.shortTermDisabledStandardApplicationKeys),
    shortTermApplicationConfigMode: asConfigMode(o.shortTermApplicationConfigMode),
    cosignerCustomApplicationFields: normalizeCustomApplicationFields(o.cosignerCustomApplicationFields),
    cosignerDisabledStandardApplicationKeys: asStringArray(o.cosignerDisabledStandardApplicationKeys),
    cosignerApplicationConfigMode: asConfigMode(o.cosignerApplicationConfigMode),
    shareAcrossVariants: o.shareAcrossVariants !== false,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : undefined,
  };
  return applyShareAcrossVariants(template);
}

/** True once a manager has saved at least one question or disabled a standard one. */
export function workspaceApplicationFormIsConfigured(
  template: WorkspaceApplicationFormTemplate | null | undefined,
): boolean {
  if (!template) return false;
  return (
    template.customApplicationFields.length > 0 ||
    template.disabledStandardApplicationKeys.length > 0 ||
    template.applicationConfigMode === "custom"
  );
}

/**
 * The listing-side fields the resolver reads from and writes back onto — the
 * same shape `applicationConfigForVariant` already reads (that function types
 * these as `unknown` and normalizes them itself, so concrete types here are
 * strictly more useful to callers and remain structurally compatible).
 */
export type ListingApplicationFormFields = {
  applicationFormSource?: "workspace" | "custom";
  customApplicationFields?: ManagerCustomApplicationField[];
  disabledStandardApplicationKeys?: string[];
  applicationConfigMode?: "standard" | "custom";
  shortTermCustomApplicationFields?: ManagerCustomApplicationField[];
  shortTermDisabledStandardApplicationKeys?: string[];
  shortTermApplicationConfigMode?: "standard" | "custom";
  cosignerCustomApplicationFields?: ManagerCustomApplicationField[];
  cosignerDisabledStandardApplicationKeys?: string[];
  cosignerApplicationConfigMode?: "standard" | "custom";
};

/**
 * Resolve the effective application-form triplet (all three variants) for a
 * listing: its own fields when `applicationFormSource === "custom"`, or when
 * no workspace form has ever been saved (`workspaceForm` null — today's
 * behaviour, unaffected by this feature); otherwise the workspace template's
 * fields ("workspace" source, or absent = follows the workspace by default).
 * Returns a plain object in the exact shape `applicationConfigForVariant`
 * already reads — pass it there instead of a raw `ManagerListingSubmissionV1`.
 */
export function resolveEffectiveApplicationForm<T extends ListingApplicationFormFields>(
  listing: T | null | undefined,
  workspaceForm: WorkspaceApplicationFormTemplate | null | undefined,
): ListingApplicationFormFields {
  if (!workspaceForm || listing?.applicationFormSource === "custom") {
    return listing ?? {};
  }
  return {
    applicationFormSource: listing?.applicationFormSource,
    customApplicationFields: workspaceForm.customApplicationFields,
    disabledStandardApplicationKeys: workspaceForm.disabledStandardApplicationKeys,
    applicationConfigMode: workspaceForm.applicationConfigMode,
    shortTermCustomApplicationFields: workspaceForm.shortTermCustomApplicationFields,
    shortTermDisabledStandardApplicationKeys: workspaceForm.shortTermDisabledStandardApplicationKeys,
    shortTermApplicationConfigMode: workspaceForm.shortTermApplicationConfigMode,
    cosignerCustomApplicationFields: workspaceForm.cosignerCustomApplicationFields,
    cosignerDisabledStandardApplicationKeys: workspaceForm.cosignerDisabledStandardApplicationKeys,
    cosignerApplicationConfigMode: workspaceForm.cosignerApplicationConfigMode,
  };
}

/**
 * Same as {@link resolveEffectiveApplicationForm}, but returns a full
 * listing-submission-shaped object (spreading every other field of `sub`
 * through unchanged) so a caller can feed the result anywhere a
 * `ManagerListingSubmissionV1` is expected — `publicListingProjection` and
 * server-side validation both use this to bake the resolved triplet onto the
 * listing they already loaded, so every downstream reader (the wizard, the
 * AI tools, `validateCustomFieldAnswers`) keeps reading the plain
 * `customApplicationFields` / `shortTerm*` / `cosigner*` fields exactly as
 * before this feature existed.
 */
export function applyEffectiveApplicationForm<T extends ListingApplicationFormFields>(
  sub: T,
  workspaceForm: WorkspaceApplicationFormTemplate | null | undefined,
): T {
  const resolved = resolveEffectiveApplicationForm(sub, workspaceForm);
  return {
    ...sub,
    customApplicationFields: resolved.customApplicationFields ?? [],
    disabledStandardApplicationKeys: resolved.disabledStandardApplicationKeys ?? [],
    applicationConfigMode: resolved.applicationConfigMode,
    shortTermCustomApplicationFields: resolved.shortTermCustomApplicationFields ?? [],
    shortTermDisabledStandardApplicationKeys: resolved.shortTermDisabledStandardApplicationKeys ?? [],
    shortTermApplicationConfigMode: resolved.shortTermApplicationConfigMode,
    cosignerCustomApplicationFields: resolved.cosignerCustomApplicationFields ?? [],
    cosignerDisabledStandardApplicationKeys: resolved.cosignerDisabledStandardApplicationKeys ?? [],
    cosignerApplicationConfigMode: resolved.cosignerApplicationConfigMode,
  };
}

/** True when this listing's effective form is actually coming from the workspace template (not its own fields). */
export function listingFollowsWorkspaceApplicationForm(
  listing: Pick<ListingApplicationFormFields, "applicationFormSource"> | null | undefined,
  workspaceForm: WorkspaceApplicationFormTemplate | null | undefined,
): boolean {
  return Boolean(workspaceForm) && listing?.applicationFormSource !== "custom";
}
