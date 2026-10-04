/**
 * Send & upload: which FORM a manager is sending.
 *
 * "Send application" picks one of the property's PUBLISHED application forms (the apply link carries
 * that form's id); "Send lease" picks one of the property's lease forms, with the lease mapped from
 * the application's form always first. Pure and isomorphic: the invite route re-runs
 * `applicationFormIdForLink` on the server, so a link can never name a form the property does not offer.
 */
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  applicationFormVariantForTemplate,
  readPropertyApplicationTemplates,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import { leaseIdForApplication, mappableApplicationTemplates } from "@/lib/application-lease-mapping";
import { readPropertyLeaseTemplates } from "@/lib/property-lease-templates";
import { listLeaseTemplateGenerateChoices } from "@/lib/property-lease-template-sync";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import { readLeaseFeeWaiver } from "@/lib/lease-at-signing";
import { leaseSendSchedule } from "@/lib/lease-send-terms";

export type ApplicationFormChoice = {
  id: string;
  label: string;
  /** The lease this application maps to, or "" when unmapped. */
  leaseLabel: string;
  variant: "standard" | "short_term";
};

/** Published, non-co-signer application forms the property offers, default form first. */
export function applicationFormChoicesForProperty(
  sub: Pick<ManagerListingSubmissionV1, "propertyApplicationTemplates" | "propertyLeaseTemplates"> | null | undefined,
): ApplicationFormChoice[] {
  if (!sub) return [];
  const applications = mappableApplicationTemplates(
    readPropertyApplicationTemplates(sub).filter((template) => Boolean(template.publishedQuestionConfig)),
  );
  const leases = readPropertyLeaseTemplates(sub);
  const catalog = { applications: readPropertyApplicationTemplates(sub), leases };
  const rows = applications.map((template: PropertyApplicationTemplate): ApplicationFormChoice => {
    const leaseId = leaseIdForApplication(catalog, template.id);
    return {
      id: template.id,
      label: template.label.trim() || "Application",
      leaseLabel: leases.find((lease) => lease.id === leaseId)?.label.trim() ?? "",
      variant: applicationFormVariantForTemplate(template) === "short_term" ? "short_term" : "standard",
    };
  });
  // The long-term form is the one a plain apply link already serves, so it stays the default.
  return [...rows.filter((row) => row.variant === "standard"), ...rows.filter((row) => row.variant !== "standard")];
}

export function defaultApplicationFormId(choices: readonly ApplicationFormChoice[]): string {
  return choices[0]?.id ?? "";
}

/**
 * The form id an apply link may carry: it must be one of the property's published forms. A link
 * to the default form carries no id at all (it is what a plain link already serves).
 */
export function applicationFormIdForLink(
  sub: Pick<ManagerListingSubmissionV1, "propertyApplicationTemplates" | "propertyLeaseTemplates"> | null | undefined,
  requestedId: string | null | undefined,
): string | undefined {
  const id = requestedId?.trim();
  if (!id) return undefined;
  const choices = applicationFormChoicesForProperty(sub);
  if (!choices.some((choice) => choice.id === id)) return undefined;
  return id === defaultApplicationFormId(choices) ? undefined : id;
}

export type LeaseFormChoice = { id: string; label: string };

/** The lease forms the property holds for this application, the lease it maps to first (the default). */
export function leaseFormChoicesForApplication(
  sub: ManagerListingSubmissionV1 | null | undefined,
  application: Pick<Partial<RentalWizardFormState>, "leaseTerm" | "rentalType" | "bundleId" | "applicationTemplateId">,
  leaseKind: "individual" | "joint_bundle" = "individual",
): { choices: LeaseFormChoice[]; defaultId: string } {
  if (!sub) return { choices: [], defaultId: "" };
  const rows = listLeaseTemplateGenerateChoices(sub, application, leaseKind);
  const choices = rows.map((row) => ({ id: row.id, label: row.label }));
  return { choices, defaultId: choices[0]?.id ?? "" };
}

/**
 * The pin (form id + its current published version) for the form an apply link carries, or null
 * when the link names no form or one the property no longer publishes. The wizard uses it to start
 * the applicant on exactly that form, and to keep it when they pick a lease type.
 */
export function applicationPinForLinkedForm(
  sub: Pick<ManagerListingSubmissionV1, "propertyApplicationTemplates" | "propertyLeaseTemplates"> | null | undefined,
  formId: string | null | undefined,
): { templateId: string; templateVersion: number } | null {
  const id = formId?.trim();
  if (!sub || !id) return null;
  if (!applicationFormChoicesForProperty(sub).some((choice) => choice.id === id)) return null;
  const template = readPropertyApplicationTemplates(sub).find((row) => row.id === id);
  const published = template?.publishedQuestionConfig;
  return published ? { templateId: id, templateVersion: published.version } : null;
}

/**
 * The lease fee the Send lease screen shows, and whether this resident's fee is waived. The
 * billing snapshot reads a waiver as "owed nothing", so the nominal amount is read with the waiver
 * lifted: the manager sees what is being waived and can restore it.
 */
export function leaseFeeForSend(
  applicant: Parameters<typeof leaseSendSchedule>[0],
  managerUserId: string | null,
): { fee: number; waived: boolean } {
  const waived = readLeaseFeeWaiver(applicant.application) !== null;
  const nominal = waived
    ? ({ ...applicant, application: { ...(applicant.application ?? {}), managerLeaseFeeWaiver: null } } as typeof applicant)
    : applicant;
  const row = leaseSendSchedule(nominal, managerUserId).find((entry) => entry.key === "lease_fee");
  return { fee: row?.amount ?? 0, waived };
}
