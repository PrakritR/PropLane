"use client";

/**
 * The one "you just published" confirmation, shown after every publish path
 * (new listing, draft → live, and the last property of a multi-property
 * import) instead of navigating straight to the listing detail page.
 *
 * That immediate navigation used to be the only feedback a manager got —
 * publish and the screen was already gone. This dialog is the pause: it
 * confirms the listing is live, shows the public link, and lets the manager
 * choose where to go next rather than deciding for them (PRP-496).
 *
 * `name`/`listingId` come from the caller — this component never fetches.
 * `zillowIncluded` is optional and omitted by every current call site: none
 * of them has a cheap, definitely-current read of the just-published
 * submission's syndication opt-in (the local row a caller might have is from
 * before this publish and can be stale), so the line is left out rather than
 * risking a wrong answer (`docs/agents/listing-syndication.md`).
 */

import { Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmRows, PortalDialog } from "@/components/portal/portal-dialog";
import { buildManagerListingUrl, copyTextToClipboard } from "@/lib/manager-property-links";

export function ListingPublishedDialog({
  open,
  name,
  listingId,
  zillowIncluded,
  onViewListing,
  onBackToProperties,
  onShare,
  showToast,
}: {
  open: boolean;
  /** Display name for the "Listing" row — `propertyRowTitle`/`managerPropertyRowTitle` at the call site. */
  name: string;
  /** Builds the public listing URL. Never used for anything else. */
  listingId: string;
  /** Only rendered when explicitly true. */
  zillowIncluded?: boolean;
  /** Primary action — the existing router push to the detail preview route. */
  onViewListing: () => void;
  /** Secondary footer action. Also wired to the header ✕, outside click, and Escape. */
  onBackToProperties: () => void;
  /**
   * Opens the page's own share sheet (e.g. `openShareListing` / `onSendToProspect`)
   * when the caller has that page context. Omit it to fall back to copying the
   * public link with a toast.
   */
  onShare?: () => void;
  showToast?: (message: string) => void;
}) {
  const publicUrl = buildManagerListingUrl(typeof window === "undefined" ? "" : window.location.origin, listingId);

  const handleShare = () => {
    if (onShare) {
      onShare();
      return;
    }
    void copyTextToClipboard(publicUrl).then((ok) => {
      showToast?.(ok ? "Listing link copied." : "Could not copy. Copy it from the field above.");
    });
  };

  return (
    <PortalDialog
      open={open}
      onClose={onBackToProperties}
      title="Listing published"
      dataAttr="listing-published-dialog"
      primaryAction={{ label: "View listing", onClick: onViewListing, dataAttr: "listing-published-view" }}
      secondaryAction={{
        label: "Back to properties",
        onClick: onBackToProperties,
        dataAttr: "listing-published-back",
      }}
    >
      <div className="space-y-4">
        <ConfirmRows
          rows={[
            { label: "Listing", value: name },
            { label: "Status", value: "Live" },
            ...(zillowIncluded ? [{ label: "Zillow feed", value: "Included" }] : []),
          ]}
        />
        <div className="flex items-center gap-2">
          <Input readOnly value={publicUrl} className="font-mono text-xs" data-attr="listing-published-url" />
          <Button
            type="button"
            variant="outline"
            className="shrink-0"
            data-attr="listing-published-share"
            onClick={handleShare}
          >
            <Share2 className="h-4 w-4" aria-hidden />
            <span className="ml-1.5">Share</span>
          </Button>
        </div>
      </div>
    </PortalDialog>
  );
}
