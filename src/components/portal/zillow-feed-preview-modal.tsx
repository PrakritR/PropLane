"use client";

import { Modal } from "@/components/ui/modal";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  listingSyndicationHasStreetAddress,
  listingSyndicationPhotoUrls,
  monthlyRentDollarsForSyndication,
} from "@/lib/listing-syndication/zillow-feed";
import { resolveZillowSyndicationStatus } from "@/lib/listing-syndication/zillow-syndication-status";

function formatMoney(monthly: number | null): string {
  if (monthly == null || monthly <= 0) return "Not set";
  return `From $${monthly.toLocaleString("en-US")}/mo`;
}

export function ZillowFeedPreviewModal({
  open,
  onClose,
  title,
  sub,
  listingStatus,
  workPhone,
  workEmail,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  sub: ManagerListingSubmissionV1;
  listingStatus?: string | null;
  workPhone?: string | null;
  workEmail?: string | null;
}) {
  const status = resolveZillowSyndicationStatus({ sub, listingStatus });
  const address = sub.address?.trim() || "";
  const hoodZip = [sub.neighborhood?.trim(), sub.zip?.trim()].filter(Boolean).join(" · ");
  const rent = formatMoney(monthlyRentDollarsForSyndication(sub));
  const roomCount = (sub.rooms ?? []).filter((r) => r.name?.trim()).length;
  const bathCount = sub.bathrooms?.length ?? 0;
  const photoCount = listingSyndicationPhotoUrls(sub).length;
  const description =
    sub.marketingNotes?.trim() ||
    sub.tagline?.trim() ||
    (title ? `Rooms for rent at ${title}. Tour, apply and sign online.` : "");

  const banner =
    status.code === "blocked"
      ? status.text
      : status.code === "off"
        ? "Not sending to Zillow Rental Network"
        : status.code === "unlisted"
          ? "Unlisted: left out of the feed"
          : status.text;

  return (
    <Modal open={open} title={`Preview feed · ${title}`} onClose={onClose} panelClassName="max-w-lg">
      <div className="space-y-4" data-attr="zillow-feed-preview">
        <div
          className={`rounded-xl border px-3.5 py-2.5 text-sm font-semibold ${
            status.code === "blocked"
              ? "border-amber-200 bg-amber-50 text-amber-950"
              : status.code === "live" || status.code === "sent"
                ? "border-emerald-200 bg-emerald-50 text-emerald-950"
                : "border-border bg-accent/30 text-foreground"
          }`}
        >
          {banner}
        </div>
        <div className="rounded-2xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <p className="font-bold text-foreground">{title}</p>
            <p className="text-xs text-muted">One listing for the house</p>
          </div>
          <dl className="divide-y divide-border text-sm">
            <PreviewRow label="Street address" value={address || "Missing"} bad={!listingSyndicationHasStreetAddress(address)} />
            <PreviewRow label="Neighborhood · ZIP" value={hoodZip || "Not set"} />
            <PreviewRow label="Rent" value={rent} />
            <PreviewRow
              label="Rooms · Baths"
              value={`${roomCount} room${roomCount === 1 ? "" : "s"} · ${bathCount} bath${bathCount === 1 ? "" : "s"}`}
            />
            <PreviewRow
              label="Photos"
              value={photoCount > 0 ? `${photoCount} photo${photoCount === 1 ? "" : "s"}` : "None"}
              bad={photoCount === 0}
            />
            <PreviewRow label="Description" value={description.length > 120 ? `${description.slice(0, 117)}…` : description} />
            <PreviewRow
              label="Contact"
              value={[workPhone?.trim(), workEmail?.trim()].filter(Boolean).join(" · ") || "Work number and email"}
            />
          </dl>
          <div className="border-t border-border px-4 py-3 text-xs text-muted">
            <span className="font-bold uppercase tracking-wide text-foreground">Never sent</span>
            <p className="mt-1 font-semibold text-foreground">
              Door and Wi-Fi codes · resident names · personal phone or email
            </p>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function PreviewRow({ label, value, bad = false }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="grid gap-1 px-4 py-2.5 sm:grid-cols-[minmax(7rem,auto)_1fr] sm:gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className={`font-semibold ${bad ? "text-amber-800" : "text-foreground"}`}>{value}</dd>
    </div>
  );
}
