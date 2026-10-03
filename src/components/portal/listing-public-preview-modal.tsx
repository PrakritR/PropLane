"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ListingDetailSections } from "@/components/marketing/listing-detail-sections";
import { ListingPreviewScrollShell } from "@/components/marketing/listing-preview-scroll-shell";
import { Modal } from "@/components/ui/modal";
import { ExternalLink } from "lucide-react";
import { getListingRichContent } from "@/data/listing-rich-content";
import type { MockProperty } from "@/data/types";
import { useListingContactSmsPhone } from "@/hooks/use-listing-contact-sms-phone";
import { useListingContactWorkEmail } from "@/hooks/use-listing-contact-work-email";
import { withListingContactSmsPhone, withListingContactWorkEmail } from "@/lib/listing-contact-sms";

/**
 * Full listing UI exactly as renters see on /rent/listings/[id], in a scrollable overlay.
 * Optional footer for manager/admin actions below the public content.
 */
export function ListingPublicPreviewModal({
  open,
  onClose,
  property,
  footer,
  publicHref,
}: {
  open: boolean;
  onClose: () => void;
  property: MockProperty | null;
  footer?: ReactNode;
  /** When set, shows “Open public page” next to Close. */
  publicHref?: string | null;
}) {
  const contactSmsPhone = useListingContactSmsPhone({
    listingId: property?.id,
    ownerManagerUserId: property?.managerUserId,
    enabled: open && Boolean(property),
  });
  const contactWorkEmail = useListingContactWorkEmail({
    listingId: property?.id,
    ownerManagerUserId: property?.managerUserId,
    enabled: open && Boolean(property),
  });

  if (!open || !property) return null;

  const previewProperty = withListingContactWorkEmail(
    withListingContactSmsPhone(property, contactSmsPhone),
    contactWorkEmail,
  );
  const rich = getListingRichContent(previewProperty);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={[property.buildingName, property.unitLabel].filter(Boolean).join(" · ") || "Listing preview"}
      assistantContext="Listing preview"
      contextPanel={<dl className="space-y-3 text-sm"><div><dt className="text-muted">Property</dt><dd>{property.buildingName}</dd></div>{property.unitLabel ? <div><dt className="text-muted">Unit</dt><dd>{property.unitLabel}</dd></div> : null}</dl>}
      status={publicHref ? <Link href={publicHref} target="_blank" rel="noopener noreferrer" data-attr="listing-open-public-page" aria-label="Open public page" title="Open public page" className="flex size-11 items-center justify-center rounded-full border border-border"><ExternalLink className="size-5" aria-hidden /></Link> : undefined}
      footer={footer}
    >
      <ListingPreviewScrollShell className="min-h-0 flex-1">
        <ListingDetailSections property={previewProperty} rich={rich} previewModal hidePreviewSubnav />
      </ListingPreviewScrollShell>
    </Modal>
  );
}
