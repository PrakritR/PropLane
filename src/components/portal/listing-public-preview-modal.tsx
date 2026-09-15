"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ListingDetailSections } from "@/components/marketing/listing-detail-sections";
import { ListingPreviewScrollShell } from "@/components/marketing/listing-preview-scroll-shell";
import { ModalShell, MODAL_HEADER_CLOSE_CLASS, useModalPresentation } from "@/components/ui/modal";
import {
  MODAL_FULL_PAGE_CENTER_CLASS,
  MODAL_FULL_PAGE_PANEL_CLASS,
  MODAL_FULL_PAGE_STACK_CLASS,
  MODAL_PANEL_CLASS,
  MODAL_XL_PANEL_CLASS,
} from "@/components/ui/modal-styles";
import { X } from "lucide-react";
import { getListingRichContent } from "@/data/listing-rich-content";
import type { MockProperty } from "@/data/types";
import { useListingContactSmsPhone } from "@/hooks/use-listing-contact-sms-phone";
import { useListingContactWorkEmail } from "@/hooks/use-listing-contact-work-email";
import { withListingContactSmsPhone, withListingContactWorkEmail } from "@/lib/listing-contact-sms";
import { cn } from "@/lib/utils";
import { useIsNativeApp } from "@/hooks/use-is-native-app";

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

  const { isNative } = useIsNativeApp();
  const useFullPageModal = isNative === true;
  const presentation = useModalPresentation();

  if (!open || !property) return null;

  const previewProperty = withListingContactWorkEmail(
    withListingContactSmsPhone(property, contactSmsPhone),
    contactWorkEmail,
  );
  const rich = getListingRichContent(previewProperty);

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      presentation={useFullPageModal ? "dialog" : presentation}
      stackClassName={useFullPageModal ? MODAL_FULL_PAGE_STACK_CLASS : undefined}
      centerClassName={useFullPageModal ? MODAL_FULL_PAGE_CENTER_CLASS : undefined}
      panelClassName={cn(
        useFullPageModal ? MODAL_FULL_PAGE_PANEL_CLASS : MODAL_PANEL_CLASS,
        useFullPageModal ? "px-0" : MODAL_XL_PANEL_CLASS,
        "px-0",
      )}
      ariaLabelledBy="listing-preview-title"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <p id="listing-preview-title" className="truncate text-sm font-semibold text-foreground">
            {property.buildingName} · {property.unitLabel}
          </p>
          <p className="text-xs text-muted">Public listing preview · matches Rent with PropLane</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {publicHref ? (
            <Link
              href={publicHref}
              target="_blank"
              rel="noopener noreferrer"
              data-attr="listing-open-public-page"
              className="rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-accent/30"
            >
              Open public page
            </Link>
          ) : null}
          <button
            type="button"
            className={MODAL_HEADER_CLOSE_CLASS}
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </div>
      <ListingPreviewScrollShell className="max-h-[min(70vh,40rem)] min-h-0 flex-1">
        <ListingDetailSections property={previewProperty} rich={rich} previewModal hidePreviewSubnav />
      </ListingPreviewScrollShell>
      {footer ? (
        <div className="shrink-0 border-t border-border bg-card px-4 py-4 sm:px-5">{footer}</div>
      ) : null}
    </ModalShell>
  );
}
