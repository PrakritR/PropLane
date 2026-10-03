"use client";

import { useMemo } from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RentalApplicationWizard } from "@/components/marketing/rental-application-wizard";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  applicationFormVariantForTemplate,
  draftQuestionConfigForTemplate,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import { mergeApplicationConfigForVariant } from "@/lib/rental-application/application-field-catalog";

export function PropertyApplicationTemplateInlinePreview({
  template,
  sub,
  propertyId,
  onBack,
  solo = false,
}: {
  template: PropertyApplicationTemplate;
  sub: ManagerListingSubmissionV1;
  propertyId?: string | null;
  onBack?: () => void;
  solo?: boolean;
}) {
  const variant = applicationFormVariantForTemplate(template);
  const draft = draftQuestionConfigForTemplate(template);
  const previewSub = useMemo(() => {
    if (!draft) return sub;
    return { ...sub, ...mergeApplicationConfigForVariant(variant, draft) };
  }, [draft, sub, variant]);

  return (
    <div className="space-y-3" data-attr="property-application-inline-preview" data-ps40-page="application-view">
      {!solo && onBack ? (
        <Button
          type="button"
          variant="ghost"
          className="ps40-back -ml-2 h-11 gap-1 px-2 text-sm font-semibold"
          data-attr="property-application-preview-back"
          onClick={onBack}
        >
          <ChevronLeft className="size-5" aria-hidden />
          Back
        </Button>
      ) : null}
      <p className="text-base font-semibold text-foreground">{template.label}</p>
      <div className="rounded-2xl border border-border bg-card p-3" data-attr="property-application-inline-preview-wizard">
        <RentalApplicationWizard
          mode="manager"
          layout="embedded"
          templatePreview
          templatePreviewSubmission={previewSub}
          templatePreviewVariant={variant}
          linkedPropertyId={propertyId ?? undefined}
          showToast={() => {}}
        />
      </div>
    </div>
  );
}
