"use client";

import { useMemo, useState } from "react";
import { Copy, ExternalLink, Link2, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { resolveZillowSyndicationStatus } from "@/lib/listing-syndication/zillow-syndication-status";
import { ZillowFeedPreviewModal } from "@/components/portal/zillow-feed-preview-modal";

export function ZillowRentalNetworkRow({
  propertyTitle,
  sub,
  listingStatus,
  workPhone,
  workEmail,
  syndicationSwitchOn = true,
  onToggle,
  onResend,
  onStop,
  onEdit,
  toggleDisabled,
  dataAttrPrefix = "zillow-syndication",
}: {
  propertyTitle: string;
  sub: ManagerListingSubmissionV1;
  listingStatus?: string | null;
  workPhone?: string | null;
  workEmail?: string | null;
  syndicationSwitchOn?: boolean;
  onToggle: (next: boolean) => void;
  onResend?: () => void;
  onStop?: () => void;
  onEdit?: () => void;
  toggleDisabled?: boolean;
  dataAttrPrefix?: string;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const status = useMemo(
    () => resolveZillowSyndicationStatus({ sub, listingStatus, syndicationSwitchOn }),
    [sub, listingStatus, syndicationSwitchOn],
  );
  const enabled = syndicationSwitchOn && sub.syndication?.zillow?.enabled === true;

  return (
    <>
      <div
        className="flex items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-3"
        data-attr={`${dataAttrPrefix}-row`}
      >
        <div
          aria-hidden
          className="grid h-[4.125rem] w-[5.5rem] shrink-0 place-items-center rounded-[10px] bg-accent/60 text-muted/80 max-md:h-[3.125rem] max-md:w-16"
        >
          <Link2 className="size-6" strokeWidth={1.6} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-foreground">Zillow Rental Network</p>
          <p className="mt-0.5 truncate text-xs font-semibold text-muted">Zillow · Trulia · HotPads</p>
          <p className="mt-1 text-xs font-semibold text-foreground">{status.text}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <PortalSettingsToggle
            checked={enabled}
            onChange={onToggle}
            label="Send to Zillow Rental Network"
            disabled={toggleDisabled}
            dataAttr={`${dataAttrPrefix}-toggle`}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <PortalIconAction icon={MoreHorizontal} label="More actions" data-attr={`${dataAttrPrefix}-menu`} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem data-attr={`${dataAttrPrefix}-preview`} onSelect={() => setPreviewOpen(true)}>
                Preview feed
              </DropdownMenuItem>
              {onEdit ? (
                <DropdownMenuItem data-attr={`${dataAttrPrefix}-edit`} onSelect={onEdit}>
                  Edit
                </DropdownMenuItem>
              ) : null}
              {enabled && onResend ? (
                <DropdownMenuItem data-attr={`${dataAttrPrefix}-resend`} onSelect={onResend}>
                  Resend
                </DropdownMenuItem>
              ) : null}
              {enabled && onStop ? (
                <DropdownMenuItem data-attr={`${dataAttrPrefix}-stop`} onSelect={onStop}>
                  Stop
                </DropdownMenuItem>
              ) : null}
              {!enabled ? (
                <DropdownMenuItem data-attr={`${dataAttrPrefix}-start`} onSelect={() => onToggle(true)}>
                  Turn on
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <ZillowFeedPreviewModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={propertyTitle}
        sub={sub}
        listingStatus={listingStatus}
        workPhone={workPhone}
        workEmail={workEmail}
      />
    </>
  );
}

/** Compact copy + open icons for a public listing link (send-listing step). */
export function SendListingLinkRow({
  label,
  url,
  onCopy,
  dataAttr = "send-listing-link",
}: {
  label: string;
  url: string;
  onCopy: () => void;
  dataAttr?: string;
}) {
  return (
    <div className={`send30-linkrow flex items-center gap-4 ${url ? "" : "opacity-60"}`} data-attr={dataAttr}>
      <input
        className="min-w-0 flex-1 rounded-xl border border-border bg-accent/30 px-3 py-2.5 text-xs text-foreground"
        aria-label={label}
        readOnly
        value={url || "Select a listing to generate a link."}
      />
      <PortalIconAction icon={Copy} label="Copy link" data-attr={`${dataAttr}-copy`} onClick={onCopy} disabled={!url} />
      {url ? (
        <PortalIconAction
          icon={ExternalLink}
          label="Open link"
          data-attr={`${dataAttr}-open`}
          onClick={() => window.open(url, "_blank", "noopener")}
        />
      ) : null}
    </div>
  );
}
