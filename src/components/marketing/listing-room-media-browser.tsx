"use client";

import { useMemo } from "react";
import type { ListingRoomRow } from "@/data/listing-rich-content";
import { listingRoomPriceMetaLine } from "@/data/listing-rich-content";
import {
  ListingSpaceMediaBrowser,
  type ListingSpaceMediaCta,
} from "@/components/marketing/listing-space-media-browser";
import {
  buildSmsDeepLink,
  isClawMessagingPubliclyEnabled,
} from "@/lib/claw-leasing-links";
import { listingApplyLabel, listingMessageLabel } from "@/lib/listing-prospect-cta-labels";
import { useProspectListingHrefs } from "@/hooks/use-prospect-listing-hrefs";
import { buildProspectApplyHref } from "@/lib/prospect-public-nav";
import { useProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";

export type ListingRoomMediaEntry = {
  room: ListingRoomRow;
  floorLabel: string;
};

export function ListingRoomMediaBrowser({
  entries,
  listingPropertyId,
  propertyLabel = null,
  contactSmsPhone = null,
  onOpenDetails,
  className = "",
}: {
  entries: ListingRoomMediaEntry[];
  listingPropertyId: string;
  propertyLabel?: string | null;
  contactSmsPhone?: string | null;
  onOpenDetails?: (entry: ListingRoomMediaEntry) => void;
  className?: string;
}) {
  const textEnabled = isClawMessagingPubliclyEnabled(contactSmsPhone);
  const label = propertyLabel?.trim() || null;
  const applyLabel = listingApplyLabel(textEnabled);
  const messageLabel = listingMessageLabel(textEnabled);
  const {
    applyHref: webApplyHref,
    messageHref: webMessageHref,
    stageMessageCompose,
  } = useProspectListingHrefs(listingPropertyId);
  const autofill = useProspectContactAutofill();
  const auth = {
    ready: autofill.ready,
    userId: autofill.userId,
    hasResidentRole: autofill.hasResidentRole,
  };

  const mediaEntries = useMemo(
    () =>
      entries.map((entry) => ({
        id: entry.room.id,
        eyebrow: entry.floorLabel,
        title: entry.room.name,
        metaLine: listingRoomPriceMetaLine(entry.room),
        availability: entry.room.availability,
        photoUrls: entry.room.modal.photoUrls,
        videoSrc: entry.room.modal.videoSrc,
        thumbLabel: entry.room.name,
      })),
    [entries],
  );

  const resolvePrimaryCta = (index: number): ListingSpaceMediaCta => {
    const entry = entries[index];
    const room = entry?.room;
    if (!room) {
      return {
        kind: "link",
        href: webApplyHref,
        label: applyLabel,
        dataAttr: "listing-room-browser-apply",
      };
    }
    const href = textEnabled
      ? buildSmsDeepLink({
          intent: "apply",
          propertyId: listingPropertyId,
          propertyLabel: label,
          roomName: room.name,
          toPhone: contactSmsPhone,
        })
      : buildProspectApplyHref(
          {
            propertyId: listingPropertyId,
            listingRoomId: room.id,
            listingRoomName: room.name,
            floorLabel: entry.floorLabel,
            roomPrice: room.price,
          },
          auth,
        );
    return { kind: "link", href, label: applyLabel, dataAttr: "listing-room-browser-apply" };
  };

  const resolveSecondaryCta = (index: number): ListingSpaceMediaCta => {
    const entry = entries[index];
    const href = textEnabled
      ? buildSmsDeepLink({
          intent: "question",
          propertyId: listingPropertyId,
          propertyLabel: label,
          roomName: entry?.room.name,
          toPhone: contactSmsPhone,
        })
      : webMessageHref;
    return {
      kind: "link",
      href,
      label: messageLabel,
      dataAttr: "listing-room-browser-message",
      onClick: textEnabled ? undefined : stageMessageCompose,
    };
  };

  return (
    <ListingSpaceMediaBrowser
      entries={mediaEntries}
      testId="listing-room-media-browser"
      itemNoun="room"
      availabilityVariant="room"
      onEntryPress={
        onOpenDetails
          ? (_, index) => {
              const entry = entries[index];
              if (entry) onOpenDetails(entry);
            }
          : undefined
      }
      detailsActionLabel="Room details"
      resolvePrimaryCta={(_, index) => resolvePrimaryCta(index)}
      resolveSecondaryCta={(_, index) => resolveSecondaryCta(index)}
      className={className}
    />
  );
}
