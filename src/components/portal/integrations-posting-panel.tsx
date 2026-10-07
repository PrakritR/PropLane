"use client";

import { useEffect, useMemo, useState } from "react";
import { Building, Camera, Copy, Home, Share2, Unlink } from "lucide-react";

import { IntegrationRow } from "@/components/portal/integration-row";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalSettingsGroup } from "@/components/portal/portal-settings-ui";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { getPropertyById } from "@/lib/rental-application/data";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import { MANAGER_PORTFOLIO_REFRESH_EVENTS } from "@/lib/manager-portfolio-access";
import { useListingChannels } from "@/hooks/use-listing-channels";
import { listingHoldFact } from "@/lib/listing-channels/post-text";
import { listingChannelDef } from "@/lib/listing-channels/registry";

/** Where Facebook's own rental composer lives; there is no API to post for the manager (D11). */
export const FACEBOOK_MARKETPLACE_CREATE_URL = listingChannelDef("facebook_marketplace")?.createUrl ?? "https://www.facebook.com/marketplace/create/rental";

/** "N of M listings posting" from each listing's own Zillow opt-in (`submission.syndication.zillow`). */
export function zillowPostingCounts(propertyIds: readonly string[]): { posting: number; total: number } {
  let posting = 0;
  let total = 0;
  for (const id of propertyIds) {
    const property = getPropertyById(id);
    if (!property) continue;
    total += 1;
    if (property.listingSubmission?.syndication?.zillow?.enabled === true) posting += 1;
  }
  return { posting, total };
}

/** Zillow's feed is one link per workspace, registered once; GET creates it on first read. */
function ZillowFeedRow({ propertyIds }: { propertyIds: readonly string[] }) {
  const { showToast } = useAppUi();
  const [feedUrl, setFeedUrl] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/manager/syndication-feed", { credentials: "include", cache: "no-store" })
      .then((res) => res.json())
      .then((body: { feedUrl?: string }) => {
        if (!cancelled && body.feedUrl) setFeedUrl(body.feedUrl);
      })
      .catch(() => {
        /* the copy action simply stays hidden while the link is unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    for (const name of MANAGER_PORTFOLIO_REFRESH_EVENTS) window.addEventListener(name, bump);
    return () => {
      for (const name of MANAGER_PORTFOLIO_REFRESH_EVENTS) window.removeEventListener(name, bump);
    };
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- tick re-reads the client property store
  const { posting, total } = useMemo(() => zillowPostingCounts(propertyIds), [propertyIds, tick]);

  return (
    <IntegrationRow
      icon={Home}
      tone="text-blue-600"
      name="Zillow Rental Network"
      fact={`${posting} of ${total} ${total === 1 ? "listing" : "listings"} posting`}
      factDataAttr="settings-zillow-posting-count"
      dataAttr="settings-zillow-row"
      action={
        feedUrl ? (
          <PortalIconAction
            icon={Copy}
            label="Copy Zillow feed link"
            data-attr="settings-zillow-feed-copy"
            onClick={async () => {
              const ok = await copyTextToClipboard(feedUrl);
              showToast(ok ? "Feed link copied." : "Could not copy the feed link.");
            }}
          />
        ) : (
          <span className="text-sm text-muted">Loading…</span>
        )
      }
    />
  );
}

/**
 * Facebook has no rental-posting API for us: copy the post (built on the server from the listing's
 * public facts plus the workspace work number and email), then open Facebook's composer.
 */
function FacebookMarketplaceRow({ options }: { options: { value: string; label: string }[] }) {
  const { showToast } = useAppUi();
  const [listingId, setListingId] = useState("");
  const chosen = options.some((o) => o.value === listingId) ? listingId : (options[0]?.value ?? "");
  const { status } = useListingChannels(chosen || undefined);
  const holdReasons = status?.property?.holdReasons ?? [];
  const text = status?.property?.id === chosen ? status.property.postTexts.facebook_marketplace : undefined;

  const copyPost = async () => {
    if (!text) {
      showToast(holdReasons.length > 0 ? `${listingHoldFact(holdReasons)}.` : "Pick a listing first.");
      return;
    }
    const ok = await copyTextToClipboard(text);
    showToast(ok ? "Post copied. Paste it into Facebook." : "Could not copy the post.");
    if (ok) window.open(FACEBOOK_MARKETPLACE_CREATE_URL, "_blank", "noopener,noreferrer");
  };

  return (
    <IntegrationRow
      icon={Share2}
      tone="text-sky-600"
      name="Facebook Marketplace"
      dataAttr="settings-facebook-row"
      action={
        <>
          <div className="w-44 sm:w-56">
            <FieldSingleSelect
              hideLabel
              label="Listing"
              placeholder="Pick a listing"
              dataAttr="settings-facebook-listing"
              value={chosen}
              options={options}
              onChange={setListingId}
            />
          </div>
          <Button variant="ghost" disabled={!chosen || !text} data-attr="settings-facebook-copy-post" onClick={() => void copyPost()}>
            Copy post
          </Button>
        </>
      }
    />
  );
}

const META_CONNECT_URL = `/api/integrations/meta/connect?returnTo=${encodeURIComponent("/portal/profile?tab=spreadsheets")}`;

/** Facebook Page + Instagram post for the manager through Meta's official API once the app is approved. */
function MetaPostingRows() {
  const { showToast } = useAppUi();
  const { status, refresh } = useListingChannels();
  const live = (id: "facebook_page" | "instagram") => status?.channels.find((c) => c.id === id)?.availability === "live";
  const meta = status?.meta;
  const canManage = status?.canManage ?? false;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get("meta");
    if (flag === "connected") showToast("Facebook connected.");
    else if (flag === "error") showToast(params.get("reason") ?? "Could not connect Facebook.");
  }, [showToast]);

  const disconnect = async () => {
    const res = await fetch("/api/integrations/meta/disconnect", { method: "POST", credentials: "include" });
    showToast(res.ok ? "Facebook disconnected." : "Could not disconnect Facebook.");
    await refresh();
  };

  const pageRow = !live("facebook_page") ? (
    <IntegrationRow icon={Share2} tone="text-sky-600" name="Facebook Page" comingSoon dataAttr="settings-facebook-page-row" />
  ) : meta?.connected ? (
    <IntegrationRow
      icon={Share2}
      tone="text-sky-600"
      name="Facebook Page"
      fact={`Connected as ${meta.pageName ?? "your Page"}`}
      factDataAttr="settings-facebook-page-fact"
      dataAttr="settings-facebook-page-row"
      action={canManage ? <PortalIconAction icon={Unlink} label="Disconnect Facebook" data-attr="settings-facebook-page-disconnect" onClick={() => void disconnect()} /> : undefined}
    />
  ) : (
    <IntegrationRow
      icon={Share2}
      tone="text-sky-600"
      name="Facebook Page"
      fact={meta?.revoked ? "Reconnect Facebook" : "Not connected"}
      factDataAttr="settings-facebook-page-fact"
      dataAttr="settings-facebook-page-row"
      action={
        canManage ? (
          <Button variant="ghost" data-attr="settings-facebook-page-connect" onClick={() => (window.location.href = META_CONNECT_URL)}>
            Connect Facebook
          </Button>
        ) : undefined
      }
    />
  );

  const instagramRow = !live("instagram") ? (
    <IntegrationRow icon={Camera} tone="text-pink-600" name="Instagram" comingSoon dataAttr="settings-instagram-row" />
  ) : (
    <IntegrationRow
      icon={Camera}
      tone="text-pink-600"
      name="Instagram"
      fact={meta?.connected ? (meta.igUsername ? `Connected as @${meta.igUsername}` : "No Instagram account linked to the Page") : "Not connected"}
      factDataAttr="settings-instagram-fact"
      dataAttr="settings-instagram-row"
    />
  );

  return (
    <>
      {pageRow}
      {instagramRow}
    </>
  );
}

/** Settings → Integrations → Posting: where a listing is advertised beyond PropLane itself. */
export function ManagerPostingPanel() {
  const workspaceCtx = useWorkspaces();
  const active = workspaceCtx?.active ?? null;
  const propertyIds = useMemo(() => active?.propertyIds ?? [], [active?.propertyIds]);
  const options = useMemo(
    () => propertyIds.map((id) => ({ value: id, label: active?.propertyLabels?.[id] ?? id })),
    [propertyIds, active?.propertyLabels],
  );

  return (
    <PortalSettingsGroup>
      <ZillowFeedRow propertyIds={propertyIds} />
      <MetaPostingRows />
      <FacebookMarketplaceRow options={options} />
      <IntegrationRow icon={Building} name="Apartments.com" comingSoon dataAttr="settings-apartments-row" />
    </PortalSettingsGroup>
  );
}
