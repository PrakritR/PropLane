"use client";

import { useMemo, useState } from "react";

import { IntegrationRow } from "@/components/portal/integration-row";
import { ListingSiteGuide, type GuideListingOption } from "@/components/portal/listing-site-guide";
import { zillowPostingCounts } from "@/components/portal/integrations-posting-panel";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { useListingChannels } from "@/hooks/use-listing-channels";
import { CHANNEL_GLYPH } from "@/lib/listing-channels/channel-glyphs";
import { automaticChannelFact, shortDate } from "@/lib/listing-channels/row-fact";
import { listingChannelsOrdered, type ListingChannelDef, type ListingChannelId, type ListingChannelPostRow } from "@/lib/listing-channels/registry";

export type ZillowListingToggle = {
  enabled: boolean;
  /** Existing status line from `resolveZillowSyndicationStatus`. */
  fact: string;
  saving: boolean;
  onToggle: (next: boolean) => void;
};

const BY_HAND_FACT = "Coming soon · post by hand for now";

/** The most recent "posted by me" date across the given rows, as "Posted by you · Oct 8", else "Not posted yet". */
function manualFact(rows: readonly ListingChannelPostRow[]): string {
  const latest = rows
    .filter((r) => r.state === "posted_by_me")
    .map((r) => r.postedAt ?? r.updatedAt ?? "")
    .sort()
    .pop();
  if (latest === undefined) return "Not posted yet";
  const date = shortDate(latest);
  return date ? `Posted by you · ${date}` : "Posted by you";
}

/** Promotion › Listing sites for ONE listing: the flat list of every site, bound to that listing. */
export function PropertyListingSitesPanel({ propertyId, zillow }: { propertyId: string; zillow: ZillowListingToggle }) {
  const { status } = useListingChannels(propertyId);
  const [openId, setOpenId] = useState<ListingChannelId | null>(null);
  const holdReasons = status?.property?.holdReasons ?? [];
  const listingLive = status?.property?.live ?? true;

  const factFor = (def: ListingChannelDef): string => {
    const row = status?.posts.find((p) => p.propertyId === propertyId && p.channel === def.id) ?? null;
    if (def.posting === "feed") return zillow.fact;
    if (def.posting === "partner_only") return "Partner feed only";
    if (def.posting === "api") {
      const live = status?.channels.find((c) => c.id === def.id)?.availability === "live";
      if (!live) return BY_HAND_FACT;
      if (!status?.meta.connected) return "Not connected";
      return automaticChannelFact({ row, holdReasons, listingLive });
    }
    return manualFact(row ? [row] : []);
  };

  return (
    <div data-attr="property-listing-sites">
      {listingChannelsOrdered().map((def) => {
        const glyph = CHANNEL_GLYPH[def.id];
        return (
          <IntegrationRow
            key={def.id}
            icon={glyph.icon}
            tone={glyph.tone}
            name={def.label}
            fact={factFor(def)}
            factDataAttr={`property-listing-site-fact-${def.id}`}
            dataAttr={`listing-site-row-${def.id}`}
            onOpen={() => setOpenId(def.id)}
          />
        );
      })}
      {openId ? (
        <ListingSiteGuide
          channelId={openId}
          open
          onClose={() => setOpenId(null)}
          propertyId={propertyId}
          listings={[{ id: propertyId, label: "This listing" }]}
          zillow={openId === "zillow" ? zillow : undefined}
        />
      ) : null}
    </div>
  );
}

/** The overall Promotion › Listing sites view: every site in one list; a row opens that site's guide. */
export function WorkspaceListingSitesPanel() {
  const workspaceCtx = useWorkspaces();
  const propertyIds = useMemo(() => workspaceCtx?.active?.propertyIds ?? [], [workspaceCtx?.active?.propertyIds]);
  const labels = workspaceCtx?.active?.propertyLabels;
  const { status } = useListingChannels();
  const [openId, setOpenId] = useState<ListingChannelId | null>(null);

  const total = propertyIds.length;
  const listingsText = (n: number) => `${n} of ${total} ${total === 1 ? "listing" : "listings"}`;
  const inWorkspace = (status?.posts ?? []).filter((p) => propertyIds.includes(p.propertyId));
  const countFor = (channel: ListingChannelId, state: "posted" | "posted_by_me") =>
    new Set(inWorkspace.filter((p) => p.channel === channel && p.state === state).map((p) => p.propertyId)).size;
  const options: GuideListingOption[] = propertyIds.map((id) => ({ id, label: labels?.[id]?.trim() || id }));

  const factFor = (def: ListingChannelDef): string => {
    if (def.posting === "feed") {
      // The row and the guide it opens must make the same claim: nothing posts until Zillow approves
      // the feed, so until then the row carries the same by-hand fact as every manual channel. The
      // feed-queued count is only honest once the feed is what actually posts.
      return status?.zillowFeedApproved === true
        ? `Posts for you · ${listingsText(zillowPostingCounts(propertyIds).posting)}`
        : `Posts for you once Zillow approves · ${manualFact(inWorkspace.filter((p) => p.channel === def.id))}`;
    }
    if (def.posting === "partner_only") return "Partner feed only";
    if (def.posting === "api") {
      const live = status?.channels.find((c) => c.id === def.id)?.availability === "live";
      return live ? `Posts for you · ${listingsText(countFor(def.id, "posted"))}` : BY_HAND_FACT;
    }
    return manualFact(inWorkspace.filter((p) => p.channel === def.id));
  };

  return (
    <div data-attr="promotion-listing-sites">
      {listingChannelsOrdered().map((def) => {
        const glyph = CHANNEL_GLYPH[def.id];
        return (
          <IntegrationRow
            key={def.id}
            icon={glyph.icon}
            tone={glyph.tone}
            name={def.label}
            fact={factFor(def)}
            factDataAttr={`promotion-listing-site-fact-${def.id}`}
            dataAttr={`listing-site-row-${def.id}`}
            onOpen={() => setOpenId(def.id)}
          />
        );
      })}
      {openId ? <ListingSiteGuide channelId={openId} open onClose={() => setOpenId(null)} listings={options} /> : null}
    </div>
  );
}
