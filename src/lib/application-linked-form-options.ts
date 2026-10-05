/**
 * The forms a question can link, as the question editor's Linked forms dropdown lists them: this listing's
 * application templates and its move-in forms, each with its own fee as a plain fact.
 *
 * An application's fee is its template's own fee (`feeCentsOverride`), else the listing's application fee for
 * that form's term. A move-in form never charges.
 */
import { centsToMoneyText, moneyTextToCents, templateFeeCents } from "@/lib/form-template-fees";
import { listingApplicationFeeRaw } from "@/lib/listing-application-fee";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { applicationFormVariantForTemplate, readPropertyApplicationTemplates } from "@/lib/property-application-templates";
import type { LinkedFormRef } from "@/lib/application-linked-forms";

export type LinkedFormOptionData = { ref: LinkedFormRef; label: string; feeText: string };

export function feeFactText(cents: number | null): string {
  return cents && cents > 0 ? `Charges $${centsToMoneyText(cents)}` : "No fee";
}

export function linkedFormOptionsFromListing(
  sub: Pick<ManagerListingSubmissionV1, "propertyApplicationTemplates" | "moveInFormTemplates"> & Partial<ManagerListingSubmissionV1>,
  opts?: { excludeApplicationId?: string | null },
): LinkedFormOptionData[] {
  const applications = readPropertyApplicationTemplates(sub as ManagerListingSubmissionV1)
    .filter((template) => template.id !== opts?.excludeApplicationId)
    .map<LinkedFormOptionData>((template) => {
      const own = templateFeeCents(template, "applicationFee");
      const variant = applicationFormVariantForTemplate(template);
      const listingFee = moneyTextToCents(
        listingApplicationFeeRaw(sub as ManagerListingSubmissionV1, variant === "short_term" ? "short_term" : "standard"),
      );
      return {
        ref: { kind: "application", id: template.id },
        label: template.label.trim() || "Application",
        feeText: feeFactText(own ?? listingFee),
      };
    });
  const moveIn = (sub.moveInFormTemplates ?? []).map<LinkedFormOptionData>((template) => ({
    ref: { kind: "move_in", id: template.id },
    label: template.name.trim() || "Move-in form",
    feeText: "No fee",
  }));
  return [...applications, ...moveIn];
}
