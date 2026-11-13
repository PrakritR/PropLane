/**
 * Applicant-paid screening: the pure rules (no I/O), shared by the quote route, the checkout route, the
 * webhook fulfilment and the applicant card. See docs/agents/identity-and-screening.md.
 *
 * - The default "simple background check" is Checkr STARTER, paid by the APPLICANT through PropLane Stripe
 *   Checkout, with the total shown before they confirm.
 * - The optional ID check is Checkr's ID-verification add-on, priced into the same order.
 * - Applications, leases and tours stay free; both checks are separate per-listing settings, default ON for
 *   PropLane-managed workspaces and OFF for self-serve.
 * - The settings are PRE-APPLY requirements (`preapply.ts`): what the applicant completes BEFORE the application form
 *   opens. The server refuses the application submit until each required step is satisfied.
 */
import type { CheckrPackage } from "@/lib/checkr/config";
import { RATINGS_DISCLOSURE_LINE } from "@/lib/resident-ratings/ratings";
import {
  checkrAddOnCatalog,
  checkrPackageCatalog,
  checkrUpgradeCostCents,
  type CheckrAddOnSlug,
} from "@/lib/checkr/packages";

export const APPLICANT_DEFAULT_PACKAGE: CheckrPackage = "starter";

/** Bumped whenever the disclosure wording changes; stored with the authorization. */
export const FCRA_DISCLOSURE_VERSION = "2026-11-12.1";

/**
 * The consumer-report disclosure shown on its own, before authorization. Wording needs counsel review before
 * live rollout; the document deliberately cites no statute section.
 */
export const FCRA_DISCLOSURE_TEXT =
  "A consumer reporting agency, Checkr, will prepare a consumer report about you to help the property manager " +
  "decide whether to rent to you. The report may include criminal history, sex offender registry and global " +
  "watchlist checks and, if selected, government ID verification, credit, eviction and income information. " +
  "You have rights under the federal Fair Credit Reporting Act, including the right to a copy of the report and " +
  "to dispute anything in it that is wrong. " +
  // One line about resident ratings (`resident-ratings.md`); counsel reviews it with the rest of this wording.
  `${RATINGS_DISCLOSURE_LINE} ` +
  "This disclosure is separate from your application.";

export const FCRA_AUTHORIZATION_LABEL =
  "I have read the disclosure and authorize PropLane and Checkr to obtain a consumer report about me for this application.";

/** When the application form opens for an applicant who must Verify ID first (Checkr): once the ID product clears, or as soon as the order is placed. */
export type ApplicantIdUnlock = "clear" | "order";

export type ApplicantScreeningSettings = {
  /** Require (and offer) the government ID + live selfie check before the application. */
  idCheck: boolean;
  /** Require (and offer) the applicant-paid background check (Starter) before the application. */
  backgroundCheck: boolean;
  /** With Checkr, the application unlocks when the ID result is clear (default) or right after the order is placed. */
  idUnlock: ApplicantIdUnlock;
};

/**
 * OFF for every workspace until the manager turns a check on (captain, Nov 12: the manager chooses what an applicant
 * completes before applying; a requirement nobody chose must never block applications). `managedWorkspace` is kept so
 * callers need not change.
 */
export function defaultApplicantScreeningSettings(_managedWorkspace: boolean): ApplicantScreeningSettings {
  return { idCheck: false, backgroundCheck: false, idUnlock: "clear" };
}

export function normalizeApplicantScreeningSettings(
  raw: unknown,
  defaults: ApplicantScreeningSettings,
): ApplicantScreeningSettings {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    idCheck: typeof row.idCheck === "boolean" ? row.idCheck : defaults.idCheck,
    backgroundCheck: typeof row.backgroundCheck === "boolean" ? row.backgroundCheck : defaults.backgroundCheck,
    idUnlock: row.idUnlock === "order" || row.idUnlock === "clear" ? row.idUnlock : defaults.idUnlock,
  };
}

export type ApplicantScreeningQuote = {
  packageSlug: CheckrPackage;
  packageName: string;
  packageCents: number;
  addOnProducts: CheckrAddOnSlug[];
  idCheckCents: number;
  totalCents: number;
};

/**
 * What the applicant pays for ONE order, always recomputed from the server catalog (never a client amount).
 * Checkr has no ID-only product, so the ID check is an add-on to the Starter order.
 */
export function applicantScreeningQuote(input: { includeIdCheck: boolean }): ApplicantScreeningQuote {
  const pkg = checkrPackageCatalog().find((entry) => entry.slug === APPLICANT_DEFAULT_PACKAGE);
  const packageCents = pkg?.priceCents ?? 0;
  const addOnProducts: CheckrAddOnSlug[] = input.includeIdCheck ? ["identity_verification"] : [];
  const idCheckCents = input.includeIdCheck
    ? (checkrAddOnCatalog().find((entry) => entry.slug === "identity_verification")?.priceCents ?? 0)
    : 0;
  return {
    packageSlug: APPLICANT_DEFAULT_PACKAGE,
    packageName: pkg?.name ?? "Starter",
    packageCents,
    addOnProducts,
    idCheckCents,
    totalCents: packageCents + idCheckCents,
  };
}

/**
 * The amount for a manager upgrading an applicant who already has a paid check: the package price difference,
 * and only the package difference. The ID add-on is never charged twice.
 */
export function applicantUpgradeCents(from: CheckrPackage, to: CheckrPackage): number {
  return checkrUpgradeCostCents(from, to);
}

/** Why the applicant card draws nothing or draws "ID check unavailable". */
export type ApplicantScreeningOffer =
  | { kind: "none" }
  | { kind: "offer"; quote: ApplicantScreeningQuote; idCheck: boolean; backgroundCheck: boolean }
  | { kind: "id_unavailable" };

/**
 * One decision for what the applicant is offered. A listing that turned the ID check ON while the provider is
 * not configured is "ID check unavailable" and never a silent downgrade to an unverified order.
 */
export function resolveApplicantScreeningOffer(input: {
  settings: ApplicantScreeningSettings;
  idCheckAvailable: boolean;
  backgroundCheckConfigured: boolean;
}): ApplicantScreeningOffer {
  const { settings } = input;
  if (!settings.idCheck && !settings.backgroundCheck) return { kind: "none" };
  if (settings.idCheck && !input.idCheckAvailable) return { kind: "id_unavailable" };
  if (!input.backgroundCheckConfigured) return { kind: "none" };
  return {
    kind: "offer",
    quote: applicantScreeningQuote({ includeIdCheck: settings.idCheck }),
    idCheck: settings.idCheck,
    backgroundCheck: settings.backgroundCheck,
  };
}

export type ApplicantScreeningView = {
  offer: ApplicantScreeningOffer;
  disclosure: { version: string; text: string; authorizationLabel: string };
  /** The applicant sees progress and the ID fact, never the report itself. */
  check: { status: "pending" | "complete" | "canceled"; idVerified: boolean } | null;
};
