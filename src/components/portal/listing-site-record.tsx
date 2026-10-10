"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { CalendarDays, Download, ExternalLink, Home, Undo2 } from "lucide-react";

import { HeldLine, listingGuideModeLine } from "@/components/portal/listing-site-guide";
import { CopyIconAction } from "@/components/portal/portal-icon-action";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PortalRecordActions, PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import {
  RecordFactCard,
  RecordFactRow,
  RecordRowsCard,
  RecordStatTiles,
  StatTile,
} from "@/components/portal/portal-record-overview-kit";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalRecordHeaderIconActions, PortalRecordSectionChrome } from "@/components/portal/portal-record-section-chrome";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { RecordActionContext } from "@/components/ui/record-action-context";
import {
  fetchListingPostText,
  postListingChannelWrite,
  useListingChannels,
  useListingSiteLeads,
} from "@/hooks/use-listing-channels";
import { CHANNEL_GLYPH } from "@/lib/listing-channels/channel-glyphs";
import type { ListingSiteLead } from "@/lib/listing-channels/leads";
import {
  listingPickerLabel,
  listingPickerOptions,
  type ListingPickerSource,
} from "@/lib/listing-channels/listing-picker";
import { listingHoldFact, taggedLinkFromPostText } from "@/lib/listing-channels/post-text";
import { listingChannelDef, type ListingChannelId, type ListingChannelPostRow } from "@/lib/listing-channels/registry";
import { automaticChannelFact, shortDate } from "@/lib/listing-channels/row-fact";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import {
  applicationDetailHref,
  listingSiteDetailHref,
  listingSitesListHref,
  managerTourDetailHref,
  type ApplicationBucketId,
  type ListingSiteTabId,
  type ManagerTourBucketId,
} from "@/lib/portal-detail-routes";
import { recordSections } from "@/lib/portals/record-sections";
import { getPropertyById } from "@/lib/rental-application/data";

const PICK_KEY = "listing-site-pick:";

function rememberedPick(channelId: string): string {
  try {
    return window.localStorage.getItem(`${PICK_KEY}${channelId}`) ?? "";
  } catch {
    return "";
  }
}

function rememberPick(channelId: string, propertyId: string) {
  try {
    window.localStorage.setItem(`${PICK_KEY}${channelId}`, propertyId);
  } catch {
    /* a remembered pick is a convenience */
  }
}

const isPosted = (row: ListingChannelPostRow | null | undefined) => row?.state === "posted_by_me" || row?.state === "posted";

/**
 * Promotion › Listing sites › one site, as a record page (studio plan listing-site-record-1009):
 * Overview · Listings · Post · Leads, built like the Vendor record page. Writes stay owner-gated.
 */
export function ListingSiteRecord({
  basePath = "/portal",
  channelId,
  tab,
}: {
  basePath?: string;
  channelId: ListingChannelId;
  tab: ListingSiteTabId;
}) {
  const def = listingChannelDef(channelId)!;
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const workspaceId = useWorkspaces()?.active?.id;
  const { status, refresh } = useListingChannels(undefined, { listings: true });
  const { leads, loading: leadsLoading, error: leadsError } = useListingSiteLeads(channelId);
  const [picked, setPicked] = useState<string | null>(null);
  const [remembered] = useState(() => (typeof window === "undefined" ? "" : rememberedPick(channelId)));
  const [busy, setBusy] = useState(false);
  const [markFor, setMarkFor] = useState<ListingPickerSource | null>(null);
  const [adUrl, setAdUrl] = useState("");

  const partner = def.posting === "partner_only";
  const glyph = CHANNEL_GLYPH[def.id];
  const Glyph = glyph.icon;
  const canManage = status?.canManage ?? false;
  const availability = status?.channels.find((c) => c.id === channelId)?.availability ?? "coming_soon";
  const metaLive = availability === "live";
  const feedApproved = def.posting === "feed" && status?.zillowFeedApproved === true;
  const apiLive = def.posting === "api" && metaLive;
  const apiConnected = apiLive && status?.meta.connected === true;
  const byHand = !partner && !feedApproved && !apiLive;

  const sources = useMemo(() => (status?.listings ?? []).filter((s) => s.status !== "draft"), [status?.listings]);
  const picker = useMemo(() => listingPickerOptions(sources), [sources]);
  const optionValues = useMemo(() => new Set(picker.groups.flatMap((g) => g.options.map((o) => o.value))), [picker]);
  const selectedId = [picked, remembered].find((id): id is string => Boolean(id) && optionValues.has(id!)) ?? picker.firstId;
  const selected = sources.find((s) => s.id === selectedId) ?? null;
  const { status: selectedStatus } = useListingChannels(selectedId || undefined);

  const rowFor = (propertyId: string) => status?.posts.find((p) => p.propertyId === propertyId && p.channel === channelId) ?? null;
  const readySources = sources.filter((s) => s.holdReasons.length === 0);
  const postedCount = sources.filter((s) => isPosted(rowFor(s.id))).length;
  const leadCount = leads?.length ?? 0;

  const sections = recordSections("manager", "listingSite", { basePath, hiddenSections: partner ? ["listings", "post", "leads"] : [] }, tab);
  const siteHref = def.createUrl ?? def.guide.signupUrl;
  const headerActions = sections.headerActions.filter((a) => (a.id === "open-site" ? Boolean(siteHref) : true));
  const mode = listingGuideModeLine(def.posting, metaLive, feedApproved);

  const pickListing = (propertyId: string) => {
    setPicked(propertyId);
    rememberPick(channelId, propertyId);
  };

  const copyText = async (text: string, held: readonly ListingPickerSource["holdReasons"][number][]) => {
    if (!text) {
      showToast(held.length > 0 ? `${listingHoldFact(held)}.` : "The post is not ready yet.");
      return;
    }
    const ok = await copyTextToClipboard(text);
    showToast(ok ? `Post copied. Paste it into ${def.label}.` : "Could not copy the post.");
  };

  const copyForListing = async (source: ListingPickerSource) => {
    if (source.holdReasons.length > 0) return copyText("", source.holdReasons);
    const built = await fetchListingPostText({ workspaceId, propertyId: source.id, channel: channelId });
    return copyText(built?.text ?? "", built?.holdReasons ?? source.holdReasons);
  };

  const write = async (path: "toggle" | "mark-posted", propertyId: string, body: Record<string, unknown>) => {
    setBusy(true);
    const res = await postListingChannelWrite(path, { propertyId, channel: channelId, workspaceId: status?.workspaceId, ...body });
    if (!res.ok) showToast(res.error ?? "Could not save.");
    await refresh();
    setBusy(false);
    return res.ok;
  };

  const onHeaderAction = (actionId: string) => {
    if (actionId === "open-site" && siteHref) {
      window.open(siteHref, "_blank", "noopener,noreferrer");
      return;
    }
    if (actionId === "copy") {
      void copyText(selectedStatus?.property?.postTexts[channelId] ?? "", selected?.holdReasons ?? []);
      return;
    }
    if (actionId === "download" && selectedId) {
      window.location.assign(`/api/manager/listing-channels/photos?propertyId=${encodeURIComponent(selectedId)}`);
    }
  };

  /** One listing's plain fact on this site. */
  const factFor = (source: ListingPickerSource): string => {
    const row = rowFor(source.id);
    if (feedApproved) {
      if (source.holdReasons.length > 0) return listingHoldFact(source.holdReasons);
      return getPropertyById(source.id)?.listingSubmission?.syndication?.zillow?.enabled === true ? "Posts automatically" : "Off";
    }
    if (apiLive) {
      if (!apiConnected) return "Not connected";
      return automaticChannelFact({ row, holdReasons: source.holdReasons, listingLive: source.status === "live" });
    }
    if (isPosted(row)) {
      const date = shortDate(row?.postedAt ?? row?.updatedAt);
      return date ? `Posted ${date}` : "Posted";
    }
    if (source.holdReasons.length > 0) return listingHoldFact(source.holdReasons);
    return "Not posted yet";
  };

  /** One listing as a flat row, with the contextual ⋯ (Mark posted · Undo · View ad · Copy post). */
  const listingRow = (source: ListingPickerSource, onOpen?: () => void) => {
    const row = rowFor(source.id);
    const posted = byHand && isPosted(row);
    const url = posted && row?.postedUrl?.startsWith("https://") ? row.postedUrl : null;
    const actions = (
      <>
        {byHand && !posted && canManage ? (
          <DropdownMenuItem data-attr={`listing-site-mark-${def.id}`} onSelect={() => { setAdUrl(""); setMarkFor(source); }}>
            Mark posted
          </DropdownMenuItem>
        ) : null}
        {url ? (
          <DropdownMenuItem data-attr={`listing-site-open-ad-${def.id}`} onSelect={() => window.open(url, "_blank", "noopener,noreferrer")}>
            View ad
          </DropdownMenuItem>
        ) : null}
        {!partner && (byHand || feedApproved) ? (
          <DropdownMenuItem data-attr={`listing-site-copy-${def.id}`} onSelect={() => void copyForListing(source)}>
            Copy post
          </DropdownMenuItem>
        ) : null}
        {apiConnected && canManage && source.holdReasons.length === 0 ? (
          <DropdownMenuItem
            data-attr={`listing-site-toggle-${def.id}`}
            onSelect={() => void write("toggle", source.id, { enabled: !(row ? row.enabled : true) })}
          >
            {row && !row.enabled ? "Turn on posting" : "Turn off posting"}
          </DropdownMenuItem>
        ) : null}
        {posted && canManage ? (
          <DropdownMenuItem data-attr={`listing-site-unmark-${def.id}`} onSelect={() => void write("mark-posted", source.id, { posted: false })}>
            Undo posted
          </DropdownMenuItem>
        ) : null}
      </>
    );
    return (
      <RecordActionContext.Provider key={source.id} value={{ scope: source.id, clear: () => {}, actions }}>
        <PortalApplicantRecordRow
          name={listingPickerLabel(source.name, source.roomCount)}
          tileIcon={Home}
          omitActionView
          onSelectedChange={() => {}}
          onOpen={onOpen ?? (() => { pickListing(source.id); navigate(listingSiteDetailHref(basePath, def.id, "post")); })}
          facts={<PortalRowFact icon={posted ? Undo2 : CalendarDays}>{factFor(source)}</PortalRowFact>}
          dataAttr={`listing-site-listing-${source.id}`}
        />
      </RecordActionContext.Provider>
    );
  };

  const leadHref = (lead: ListingSiteLead): string =>
    lead.kind === "tour"
      ? managerTourDetailHref(basePath, lead.bucket as ManagerTourBucketId, lead.id)
      : applicationDetailHref(basePath, lead.bucket as ApplicationBucketId, lead.id);

  const nameOf = (propertyId: string) => {
    const source = status?.listings?.find((s) => s.id === propertyId);
    return source ? source.name : "";
  };

  const overview = (
    <div className="space-y-4" data-attr="listing-site-overview">
      {!partner ? (
        <RecordStatTiles>
          <StatTile
            label="Leads"
            value={leadsLoading ? "–" : String(leadCount)}
            href={listingSiteDetailHref(basePath, def.id, "leads")}
            dataAttr="listing-site-stat-leads"
          />
          <StatTile
            label="Posted"
            value={`${postedCount} of ${sources.length}`}
            href={listingSiteDetailHref(basePath, def.id, "listings")}
            dataAttr="listing-site-stat-posted"
          />
          <StatTile
            label="Ready to post"
            value={String(readySources.length)}
            href={listingSiteDetailHref(basePath, def.id, "post")}
            dataAttr="listing-site-stat-ready"
          />
        </RecordStatTiles>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <RecordFactCard title="How it works" dataAttr="listing-site-card-how">
          <RecordFactRow label="Posting" value={mode} />
          <RecordFactRow label="How" value={feedApproved && def.guide.howApproved ? def.guide.howApproved : def.guide.how} />
          {def.guide.cost ? <RecordFactRow label="Cost" value={def.guide.cost} /> : null}
          {def.guide.createNote ? <RecordFactRow label="Where" value={def.guide.createNote} /> : null}
        </RecordFactCard>
        {!partner ? (
          <RecordFactCard title="Account" dataAttr="listing-site-card-account">
            {def.guide.signupNote ? <RecordFactRow label="Sign up" value={def.guide.signupNote} /> : null}
            {apiLive ? (
              <RecordFactRow
                label="Connection"
                value={
                  apiConnected ? (
                    "Connected"
                  ) : (
                    <Link href="/portal/profile?tab=spreadsheets" className="text-primary underline" data-attr={`listing-site-connect-${def.id}`}>
                      Set up
                    </Link>
                  )
                }
              />
            ) : null}
            {def.guide.signupUrl ? (
              <RecordFactRow
                label="Link"
                value={
                  <a href={def.guide.signupUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline" data-attr={`listing-site-signup-${def.id}`}>
                    {new URL(def.guide.signupUrl).host.replace(/^www\./, "")}
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                }
              />
            ) : null}
          </RecordFactCard>
        ) : null}
        {def.guide.rules.length > 0 ? (
          <RecordFactCard title="Keep the account safe" dataAttr="listing-site-guide-rules">
            <ul className="space-y-1 px-[var(--portal-card-padding,14px)] py-2.5 text-[13.5px] text-foreground">
              {def.guide.rules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </RecordFactCard>
        ) : null}
      </div>
    </div>
  );

  const listingsSection = (
    <RecordFactCard title="Listings" count={sources.length} dataAttr="listing-site-listings">
      {sources.length === 0 ? (
        <p className="px-[var(--portal-card-padding,14px)] py-5 text-center text-[13px] text-muted">
          {status ? "No listings yet." : "Loading…"}
        </p>
      ) : (
        <div className="divide-y divide-border">{sources.map((source) => listingRow(source))}</div>
      )}
    </RecordFactCard>
  );

  const postText = selectedStatus?.property?.postTexts[channelId] ?? "";
  const taggedLink = taggedLinkFromPostText(postText);
  const postSection = (
    <div className="space-y-4" data-attr="listing-site-post">
      {picker.groups.length > 0 ? (
        <FieldSingleSelect
          label="Listing"
          groups={picker.groups}
          value={selectedId}
          onChange={pickListing}
          dataAttr="listing-site-guide-picker"
        />
      ) : (
        <RecordRowsCard title="Listing" rows={[]} emptyLabel={status ? "No listings yet." : "Loading…"} dataAttr="listing-site-post-empty" />
      )}
      {selected && selected.holdReasons.length > 0 ? (
        <HeldLine reasons={selected.holdReasons} />
      ) : selected ? (
        <>
          {byHand || feedApproved ? (
            <RecordFactCard
              title="Post"
              dataAttr="listing-site-post-card"
              headerActions={
                <>
                  <CopyIconAction
                    label="Copy post"
                    data-attr={`listing-site-copy-${def.id}`}
                    disabled={!postText}
                    onCopy={() => copyText(postText, selected.holdReasons)}
                  />
                  <a
                    href={`/api/manager/listing-channels/photos?propertyId=${encodeURIComponent(selected.id)}`}
                    download
                    className="grid size-9 place-items-center rounded-full text-foreground/80 hover:bg-foreground/5"
                    data-attr={`listing-site-photos-${def.id}`}
                    aria-label="Download photos"
                    title="Download photos"
                  >
                    <Download className="size-4" aria-hidden />
                  </a>
                </>
              }
            >
              {postText ? (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-[var(--portal-card-padding,14px)] py-3 text-[13px] text-foreground" data-attr="listing-site-guide-post">
                  {postText}
                </pre>
              ) : (
                <p className="px-[var(--portal-card-padding,14px)] py-5 text-center text-[13px] text-muted">Loading…</p>
              )}
            </RecordFactCard>
          ) : null}
          {taggedLink && (byHand || feedApproved) ? (
            <RecordFactCard title="Tagged link" dataAttr="listing-site-link-card">
              <RecordFactRow
                label="Link"
                value={
                  <span className="flex min-w-0 items-center gap-1">
                    <code className="min-w-0 flex-1 break-all text-[12.5px]" data-attr="listing-site-tagged-link">{taggedLink}</code>
                    <CopyIconAction
                      label="Copy link"
                      data-attr={`listing-site-copy-link-${def.id}`}
                      onCopy={async () => {
                        const ok = await copyTextToClipboard(taggedLink);
                        showToast(ok ? "Link copied." : "Could not copy the link.");
                      }}
                    />
                  </span>
                }
              />
            </RecordFactCard>
          ) : null}
          <RecordFactCard title="Status" dataAttr="listing-site-post-status">
            {listingRow(selected, () => {})}
          </RecordFactCard>
        </>
      ) : null}
    </div>
  );

  const leadsSection = (
    <RecordFactCard title="Leads" count={leads?.length} dataAttr="listing-site-leads">
      {leadsError ? (
        <p className="px-[var(--portal-card-padding,14px)] py-5 text-center text-[13px] text-muted" data-attr="listing-site-leads-error">Could not load leads.</p>
      ) : leadsLoading ? (
        <p className="px-[var(--portal-card-padding,14px)] py-5 text-center text-[13px] text-muted" role="status">Loading…</p>
      ) : !leads || leads.length === 0 ? (
        <p className="px-[var(--portal-card-padding,14px)] py-5 text-center text-[13px] text-muted" data-attr="listing-site-leads-empty">
          No leads from {def.label} yet.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {leads.map((lead) => {
            const place = nameOf(lead.propertyId);
            return (
              <PortalApplicantRecordRow
                key={`${lead.kind}-${lead.id}`}
                name={lead.name}
                address={[lead.kind === "tour" ? "Tour" : "Application", place].filter(Boolean).join(" · ")}
                omitActionView
                facts={lead.at ? <PortalRowFact icon={CalendarDays}>{shortDate(lead.at)}</PortalRowFact> : undefined}
                onOpen={() => navigate(leadHref(lead))}
                dataAttr={`listing-site-lead-${lead.kind}`}
              />
            );
          })}
        </div>
      )}
    </RecordFactCard>
  );

  let body: ReactNode = overview;
  if (!partner) {
    if (tab === "listings") body = listingsSection;
    else if (tab === "post") body = postSection;
    else if (tab === "leads") body = leadsSection;
  }

  return (
    <>
      <PortalRecordDetailPage
        pageTitle="Listing sites"
        title={def.label}
        subtitle={mode}
        leading={
          <span className="grid size-[38px] place-items-center rounded-lg bg-accent/60" aria-hidden>
            <Glyph className={`size-5 ${glyph.tone}`} />
          </span>
        }
        backHref={listingSitesListHref(basePath)}
        backLabel="Back to listing sites"
        hideBackText
        bareHeader
        dataAttrBack="listing-site-back"
        iconTitleActions
        pinScrollBody
      >
        <PortalRecordActions>
          <PortalRecordHeaderIconActions
            actions={headerActions}
            onAction={onHeaderAction}
            primaryId={tab === "post" ? "copy" : undefined}
          />
        </PortalRecordActions>
        <PortalRecordSectionChrome
          sections={sections}
          recordId={def.id}
          activeId={tab}
          title={def.label}
          subtitle={mode}
          backHref={listingSitesListHref(basePath)}
          backLabel="All listing sites"
          ariaLabel="Listing site sections"
          onHeaderAction={onHeaderAction}
        >
          {body}
        </PortalRecordSectionChrome>
      </PortalRecordDetailPage>
      {markFor ? (
        <PortalDialog
          open
          onClose={() => setMarkFor(null)}
          title={`Mark posted on ${def.label}`}
          fullScreenMobile={false}
          dataAttr="listing-site-mark-dialog"
          primaryAction={{
            label: "Mark posted",
            disabled: busy,
            dataAttr: "listing-site-mark-confirm",
            onClick: async () => {
              const url = adUrl.trim();
              const ok = await write("mark-posted", markFor.id, { posted: true, ...(url ? { postedUrl: url } : {}) });
              if (ok) setMarkFor(null);
            },
          }}
        >
          <input
            type="url"
            value={adUrl}
            onChange={(e) => setAdUrl(e.target.value)}
            placeholder="Ad link (optional)"
            aria-label="Ad link"
            data-attr={`listing-site-posted-url-${def.id}`}
            className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-sm text-foreground"
          />
        </PortalDialog>
      ) : null}
    </>
  );
}
