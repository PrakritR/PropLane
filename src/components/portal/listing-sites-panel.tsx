"use client";

import { useMemo, useState } from "react";
import {
  Briefcase,
  Building,
  Camera,
  Globe,
  Home,
  MapPin,
  Megaphone,
  Share2,
  Sofa,
  Undo2,
  Users,
  Check,
  type LucideIcon,
} from "lucide-react";

import { IntegrationRow } from "@/components/portal/integration-row";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { postListingChannelWrite, useListingChannels } from "@/hooks/use-listing-channels";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import {
  listingChannelsByGroup,
  requestAccessMailto,
  type ListingChannelDef,
  type ListingChannelGroup,
  type ListingChannelId,
  type ListingChannelPostRow,
} from "@/lib/listing-channels/registry";
import { listingHoldFact } from "@/lib/listing-channels/post-text";
import { automaticChannelFact, oneClickChannelFact } from "@/lib/listing-channels/row-fact";
import { zillowPostingCounts } from "@/components/portal/integrations-posting-panel";

const CHANNEL_GLYPH: Record<ListingChannelId, { icon: LucideIcon; tone: string }> = {
  zillow: { icon: Home, tone: "text-blue-600" },
  facebook_page: { icon: Share2, tone: "text-sky-600" },
  instagram: { icon: Camera, tone: "text-pink-600" },
  facebook_marketplace: { icon: Share2, tone: "text-sky-600" },
  facebook_groups: { icon: Users, tone: "text-sky-600" },
  roomster: { icon: Users, tone: "text-emerald-600" },
  roomies: { icon: Users, tone: "text-violet-600" },
  furnished_finder: { icon: Sofa, tone: "text-amber-600" },
  craigslist: { icon: Megaphone, tone: "text-purple-600" },
  zumper_padmapper: { icon: MapPin, tone: "text-orange-600" },
  apartments_com: { icon: Building, tone: "text-teal-600" },
  apartment_list: { icon: Building, tone: "text-indigo-600" },
  spareroom: { icon: Home, tone: "text-rose-600" },
  nextdoor: { icon: Globe, tone: "text-green-600" },
  google_business_profile: { icon: MapPin, tone: "text-blue-600" },
  linkedin: { icon: Briefcase, tone: "text-sky-700" },
};

const GROUP_LABEL: Record<ListingChannelGroup, string> = {
  automatic: "Automatic",
  one_click: "One-click",
  request_access: "Request access",
};

const GROUPS: ListingChannelGroup[] = ["automatic", "one_click", "request_access"];

function GroupNav({ active, onChange, dataAttrPrefix }: { active: ListingChannelGroup; onChange: (g: ListingChannelGroup) => void; dataAttrPrefix: string }) {
  return (
    <div className="px-4 pb-1 pt-3">
      <LocalDestinationNav
        items={GROUPS.map((g) => ({
          id: g,
          label: GROUP_LABEL[g],
          count: listingChannelsByGroup(g).length,
          dataAttr: `${dataAttrPrefix}-${g}`,
        }))}
        activeId={active}
        onChange={(id) => onChange(id as ListingChannelGroup)}
        ariaLabel="Listing site group"
        appearance="command"
      />
    </div>
  );
}

function RequestAccessButton({ def }: { def: ListingChannelDef }) {
  return (
    <Button
      variant="ghost"
      data-attr={`listing-site-request-${def.id}`}
      onClick={() => {
        window.location.href = requestAccessMailto(def);
      }}
    >
      Request access
    </Button>
  );
}

function ComingSoonRow({ def }: { def: ListingChannelDef }) {
  const glyph = CHANNEL_GLYPH[def.id];
  return <IntegrationRow icon={glyph.icon} tone={glyph.tone} name={def.label} comingSoon dataAttr={`listing-site-row-${def.id}`} />;
}

export type ZillowListingToggle = {
  enabled: boolean;
  /** Existing status line from `resolveZillowSyndicationStatus`. */
  fact: string;
  saving: boolean;
  onToggle: (next: boolean) => void;
};

/** Promotion › Listing sites for ONE listing. */
export function PropertyListingSitesPanel({ propertyId, zillow }: { propertyId: string; zillow: ZillowListingToggle }) {
  const { showToast } = useAppUi();
  const { status, refresh } = useListingChannels(propertyId);
  const [group, setGroup] = useState<ListingChannelGroup>("automatic");
  const [copied, setCopied] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const rowFor = (channel: ListingChannelId): ListingChannelPostRow | null =>
    status?.posts.find((p) => p.propertyId === propertyId && p.channel === channel) ?? null;
  const availability = (channel: ListingChannelId) => status?.channels.find((c) => c.id === channel)?.availability ?? "coming_soon";
  const holdReasons = status?.property?.holdReasons ?? [];
  const listingLive = status?.property?.live ?? true;
  const canManage = status?.canManage ?? false;

  const toggleChannel = async (channel: ListingChannelId, enabled: boolean) => {
    setBusy(channel);
    const res = await postListingChannelWrite("toggle", { propertyId, channel, enabled, workspaceId: status?.workspaceId });
    if (!res.ok) showToast(res.error ?? "Could not save.");
    await refresh();
    setBusy(null);
  };

  const markPosted = async (channel: ListingChannelId, posted: boolean) => {
    setBusy(channel);
    const res = await postListingChannelWrite("mark-posted", { propertyId, channel, posted, workspaceId: status?.workspaceId });
    if (!res.ok) showToast(res.error ?? "Could not save.");
    await refresh();
    setBusy(null);
  };

  const copyAndOpen = async (def: ListingChannelDef) => {
    const text = status?.property?.postTexts[def.id];
    if (!text || !def.createUrl) {
      showToast(holdReasons.length > 0 ? `${listingHoldFact(holdReasons)}.` : "The post is not ready yet.");
      return;
    }
    const ok = await copyTextToClipboard(text);
    showToast(ok ? `Post copied. Paste it into ${def.label}.` : "Could not copy the post.");
    if (ok) {
      setCopied((prev) => new Set(prev).add(def.id));
      window.open(def.createUrl, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div data-attr="property-listing-sites">
      <GroupNav active={group} onChange={setGroup} dataAttrPrefix="property-listing-sites-tab" />
      {group === "automatic"
        ? listingChannelsByGroup("automatic").map((def) => {
            const glyph = CHANNEL_GLYPH[def.id];
            if (def.id === "zillow") {
              return (
                <IntegrationRow
                  key={def.id}
                  icon={glyph.icon}
                  tone={glyph.tone}
                  name={def.label}
                  fact={zillow.fact}
                  factDataAttr="property-listing-site-fact-zillow"
                  dataAttr="listing-site-row-zillow"
                  action={
                    <PortalSettingsToggle
                      checked={zillow.enabled}
                      onChange={zillow.onToggle}
                      label={`Post to ${def.label}`}
                      disabled={zillow.saving}
                      dataAttr="property-promotion-zillow-toggle"
                    />
                  }
                />
              );
            }
            if (availability(def.id) !== "live") return <ComingSoonRow key={def.id} def={def} />;
            if (!status?.meta.connected) {
              return (
                <IntegrationRow
                  key={def.id}
                  icon={glyph.icon}
                  tone={glyph.tone}
                  name={def.label}
                  fact="Not connected"
                  dataAttr={`listing-site-row-${def.id}`}
                  action={
                    <Button variant="ghost" data-attr={`listing-site-connect-${def.id}`} onClick={() => (window.location.href = "/portal/profile?tab=spreadsheets")}>
                      Set up
                    </Button>
                  }
                />
              );
            }
            const row = rowFor(def.id);
            const noContact = holdReasons.includes("no_work_number");
            return (
              <IntegrationRow
                key={def.id}
                icon={glyph.icon}
                tone={glyph.tone}
                name={def.label}
                fact={automaticChannelFact({ row, holdReasons, listingLive })}
                factDataAttr={`property-listing-site-fact-${def.id}`}
                dataAttr={`listing-site-row-${def.id}`}
                action={
                  <PortalSettingsToggle
                    checked={row ? row.enabled : true}
                    onChange={(next) => void toggleChannel(def.id, next)}
                    label={`Post to ${def.label}`}
                    disabled={busy === def.id || !canManage || noContact}
                    dataAttr={`listing-site-toggle-${def.id}`}
                  />
                }
              />
            );
          })
        : null}
      {group === "one_click"
        ? listingChannelsByGroup("one_click").map((def) => {
            const glyph = CHANNEL_GLYPH[def.id];
            const row = rowFor(def.id);
            const posted = row?.state === "posted_by_me";
            return (
              <IntegrationRow
                key={def.id}
                icon={glyph.icon}
                tone={glyph.tone}
                name={def.label}
                fact={oneClickChannelFact({ row, holdReasons })}
                factDataAttr={`property-listing-site-fact-${def.id}`}
                dataAttr={`listing-site-row-${def.id}`}
                action={
                  <>
                    <Button
                      variant="ghost"
                      disabled={holdReasons.length > 0 || !status?.property?.postTexts[def.id]}
                      data-attr={`listing-site-copy-open-${def.id}`}
                      onClick={() => void copyAndOpen(def)}
                    >
                      Copy &amp; open
                    </Button>
                    {posted ? (
                      <PortalIconAction icon={Undo2} label="Mark as not posted" data-attr={`listing-site-unmark-${def.id}`} disabled={busy === def.id || !canManage} onClick={() => void markPosted(def.id, false)} />
                    ) : copied.has(def.id) ? (
                      <PortalIconAction icon={Check} label="Posted by me" data-attr={`listing-site-mark-${def.id}`} disabled={busy === def.id || !canManage} onClick={() => void markPosted(def.id, true)} />
                    ) : null}
                  </>
                }
              />
            );
          })
        : null}
      {group === "request_access"
        ? listingChannelsByGroup("request_access").map((def) => {
            const glyph = CHANNEL_GLYPH[def.id];
            return (
              <IntegrationRow
                key={def.id}
                icon={glyph.icon}
                tone={glyph.tone}
                name={def.label}
                fact="Coming soon"
                dataAttr={`listing-site-row-${def.id}`}
                action={<RequestAccessButton def={def} />}
              />
            );
          })
        : null}
    </div>
  );
}

/** The overall Promotion › Listing sites view: every site, with how many of the workspace's listings post to it. */
export function WorkspaceListingSitesPanel() {
  const workspaceCtx = useWorkspaces();
  const propertyIds = useMemo(() => workspaceCtx?.active?.propertyIds ?? [], [workspaceCtx?.active?.propertyIds]);
  const { status } = useListingChannels();
  const [group, setGroup] = useState<ListingChannelGroup>("automatic");

  const total = propertyIds.length;
  const countFor = (channel: ListingChannelId, state: "posted" | "posted_by_me") =>
    new Set((status?.posts ?? []).filter((p) => p.channel === channel && p.state === state && propertyIds.includes(p.propertyId)).map((p) => p.propertyId)).size;
  const availability = (channel: ListingChannelId) => status?.channels.find((c) => c.id === channel)?.availability ?? "coming_soon";
  const listings = (n: number) => `${n} of ${total} ${total === 1 ? "listing" : "listings"}`;

  return (
    <div data-attr="promotion-listing-sites">
      <GroupNav active={group} onChange={setGroup} dataAttrPrefix="promotion-listing-sites-tab" />
      {group === "automatic"
        ? listingChannelsByGroup("automatic").map((def) => {
            const glyph = CHANNEL_GLYPH[def.id];
            if (def.id === "zillow") {
              const { posting } = zillowPostingCounts(propertyIds);
              return <IntegrationRow key={def.id} icon={glyph.icon} tone={glyph.tone} name={def.label} fact={`${listings(posting)} posting`} factDataAttr="promotion-listing-site-fact-zillow" dataAttr="listing-site-row-zillow" />;
            }
            if (availability(def.id) !== "live") return <ComingSoonRow key={def.id} def={def} />;
            if (!status?.meta.connected) {
              return (
                <IntegrationRow
                  key={def.id}
                  icon={glyph.icon}
                  tone={glyph.tone}
                  name={def.label}
                  fact="Not connected"
                  dataAttr={`listing-site-row-${def.id}`}
                  action={
                    <Button variant="ghost" data-attr={`listing-site-connect-${def.id}`} onClick={() => (window.location.href = "/portal/profile?tab=spreadsheets")}>
                      Set up
                    </Button>
                  }
                />
              );
            }
            return (
              <IntegrationRow
                key={def.id}
                icon={glyph.icon}
                tone={glyph.tone}
                name={def.label}
                fact={`${listings(countFor(def.id, "posted"))} posting`}
                factDataAttr={`promotion-listing-site-fact-${def.id}`}
                dataAttr={`listing-site-row-${def.id}`}
              />
            );
          })
        : null}
      {group === "one_click"
        ? listingChannelsByGroup("one_click").map((def) => {
            const glyph = CHANNEL_GLYPH[def.id];
            return (
              <IntegrationRow
                key={def.id}
                icon={glyph.icon}
                tone={glyph.tone}
                name={def.label}
                fact={`${listings(countFor(def.id, "posted_by_me"))} posted by me`}
                factDataAttr={`promotion-listing-site-fact-${def.id}`}
                dataAttr={`listing-site-row-${def.id}`}
              />
            );
          })
        : null}
      {group === "request_access"
        ? listingChannelsByGroup("request_access").map((def) => {
            const glyph = CHANNEL_GLYPH[def.id];
            return <IntegrationRow key={def.id} icon={glyph.icon} tone={glyph.tone} name={def.label} fact="Coming soon" dataAttr={`listing-site-row-${def.id}`} action={<RequestAccessButton def={def} />} />;
          })
        : null}
    </div>
  );
}
