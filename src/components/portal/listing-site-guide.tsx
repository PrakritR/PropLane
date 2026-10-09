"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Download, ExternalLink, Undo2 } from "lucide-react";

import { CopyIconAction, PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Modal, useModalPresentation } from "@/components/ui/modal";
import { postListingChannelWrite, useListingChannels } from "@/hooks/use-listing-channels";
import { CHANNEL_GLYPH } from "@/lib/listing-channels/channel-glyphs";
import { listingHoldFact } from "@/lib/listing-channels/post-text";
import { shortDate } from "@/lib/listing-channels/row-fact";
import { listingChannelDef, type ListingChannelId } from "@/lib/listing-channels/registry";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import { getPropertyById } from "@/lib/rental-application/data";

export type GuideListingOption = { id: string; label: string };
export type GuideZillowToggle = { enabled: boolean; fact: string; saving: boolean; onToggle: (next: boolean) => void };

const ICON_LINK = "grid size-9 place-items-center rounded-full text-foreground/80 hover:bg-foreground/5";

/** The one-line mode text under the site name. */
function modeLine(posting: string, metaLive: boolean): string {
  if (posting === "feed") return "Posts for you";
  if (posting === "api") return metaLive ? "Posts for you" : "Posts for you once Meta approves · by hand until then";
  if (posting === "partner_only") return "Partner feed only";
  return "Copy and post";
}

function Step({ n, done, title, note, children, action }: { n: number; done?: boolean; title: string; note?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-border py-3 last:border-0" data-attr={`listing-site-guide-step-${n}`}>
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent/60 text-xs text-foreground" aria-hidden>
        {done ? "✓" : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] text-foreground">{title}</p>
        {note ? <p className="text-sm text-muted">{note}</p> : null}
        {children}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

/**
 * The how-to for one listing site: create an account, copy the post, post it, mark it posted.
 * Workspace mode shows a listing picker; property mode (`propertyId` given) is bound to that listing.
 */
export function ListingSiteGuide({
  channelId,
  open,
  onClose,
  propertyId,
  listings = [],
  zillow,
}: {
  channelId: ListingChannelId;
  open: boolean;
  onClose: () => void;
  /** Property mode: the guide is bound to this listing and shows no picker. */
  propertyId?: string;
  /** Workspace mode: the listings the picker offers, oldest first (the newest is the default). */
  listings?: GuideListingOption[];
  /** Property mode only: Zillow's per-listing switch. */
  zillow?: GuideZillowToggle;
}) {
  const presentation = useModalPresentation();
  const def = listingChannelDef(channelId);
  const { showToast } = useAppUi();
  const [picked, setPicked] = useState<string | null>(null);
  const [postedUrl, setPostedUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedId = propertyId ?? picked ?? listings[listings.length - 1]?.id ?? "";
  const { status, refresh } = useListingChannels(selectedId || undefined);

  useEffect(() => setPostedUrl(""), [selectedId, channelId]);

  const row = status?.posts.find((p) => p.propertyId === selectedId && p.channel === channelId) ?? null;
  const posted = row?.state === "posted_by_me";
  const availability = status?.channels.find((c) => c.id === channelId)?.availability ?? "coming_soon";
  const metaLive = availability === "live";
  const holdReasons = status?.property?.holdReasons ?? [];
  const postText = status?.property?.postTexts[channelId] ?? "";
  const leads = status?.leadCounts?.[channelId] ?? 0;
  const canManage = status?.canManage ?? false;

  const zillowRows = useMemo(
    () =>
      channelId === "zillow"
        ? (propertyId ? [{ id: propertyId, label: listings.find((l) => l.id === propertyId)?.label ?? "This listing" }] : listings).map((l) => ({
            ...l,
            on: getPropertyById(l.id)?.listingSubmission?.syndication?.zillow?.enabled === true,
          }))
        : [],
    [channelId, listings, propertyId],
  );

  if (!def) return null;
  const glyph = CHANNEL_GLYPH[def.id];
  const Glyph = glyph.icon;
  const guide = def.guide;
  const partner = def.posting === "partner_only";
  const feed = def.posting === "feed";
  const apiLive = def.posting === "api" && metaLive;

  const write = async (path: "toggle" | "mark-posted", body: Record<string, unknown>) => {
    setBusy(true);
    const res = await postListingChannelWrite(path, { propertyId: selectedId, channel: def.id, workspaceId: status?.workspaceId, ...body });
    if (!res.ok) showToast(res.error ?? "Could not save.");
    await refresh();
    setBusy(false);
  };

  const copyPost = async () => {
    if (!postText) {
      showToast(holdReasons.length > 0 ? `${listingHoldFact(holdReasons)}.` : "The post is not ready yet.");
      return;
    }
    const ok = await copyTextToClipboard(postText);
    showToast(ok ? `Post copied. Paste it into ${def.label}.` : "Could not copy the post.");
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      presentation={presentation}
      dataAttr={`listing-site-guide-${def.id}`}
      title={
        <span className="flex items-center gap-2">
          <Glyph className={`size-5 ${glyph.tone}`} aria-hidden />
          {def.label}
        </span>
      }
    >
      <div className="space-y-3 pb-2" data-attr="listing-site-guide">
        <p className="text-sm text-muted" data-attr="listing-site-guide-mode">{modeLine(def.posting, metaLive)}</p>
        <p className="text-sm text-foreground" data-attr="listing-site-guide-how">{guide.how}</p>
        {feed && holdReasons.length > 0 ? (
          <p className="text-sm text-foreground" data-attr="listing-site-guide-held">{listingHoldFact(holdReasons)}</p>
        ) : null}

        {!partner && !propertyId && listings.length > 0 ? (
          <FieldSingleSelect
            label="Listing"
            options={listings.map((l) => ({ value: l.id, label: l.label }))}
            value={selectedId}
            onChange={(next) => setPicked(next)}
            dataAttr="listing-site-guide-picker"
          />
        ) : null}
        {!partner ? (
          <p className="text-sm text-muted" data-attr="listing-site-guide-leads">
            {leads} {leads === 1 ? "lead" : "leads"} from this site
          </p>
        ) : null}

        {feed && zillowRows.length > 0 ? (
          <div data-attr="listing-site-guide-status-table" className="rounded-xl border border-border">
            {zillowRows.map((r) => (
              <div key={r.id} className="flex items-center justify-between border-b border-border px-3 py-2 text-sm last:border-0">
                <span className="text-foreground">{r.label}</span>
                <span className="text-muted">
                  {r.id === selectedId && holdReasons.length > 0 ? listingHoldFact(holdReasons) : r.on ? "Posting" : "Off"}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {feed && zillow ? (
          <div className="flex items-center justify-between" data-attr="listing-site-guide-zillow-switch">
            <span className="text-sm text-foreground">{zillow.fact}</span>
            <PortalSettingsToggle
              checked={zillow.enabled}
              onChange={zillow.onToggle}
              label={`Post to ${def.label}`}
              disabled={zillow.saving}
              dataAttr="property-promotion-zillow-toggle"
            />
          </div>
        ) : null}

        {partner ? (
          <div data-attr="listing-site-guide-steps">
            <Step n={1} title="Nothing to post" />
          </div>
        ) : apiLive && status?.meta.connected ? (
          <div className="flex items-center justify-between" data-attr="listing-site-guide-api-switch">
            <span className="text-sm text-foreground">Post to {def.label}</span>
            <PortalSettingsToggle
              checked={row ? row.enabled : true}
              onChange={(next) => void write("toggle", { enabled: next })}
              label={`Post to ${def.label}`}
              disabled={busy || !canManage || holdReasons.includes("no_work_number")}
              dataAttr={`listing-site-toggle-${def.id}`}
            />
          </div>
        ) : apiLive ? (
          <Button variant="ghost" data-attr={`listing-site-connect-${def.id}`} onClick={() => (window.location.href = "/portal/profile?tab=spreadsheets")}>
            Set up
          </Button>
        ) : (
          <div data-attr="listing-site-guide-steps">
            <Step
              n={1}
              title="Create an account"
              note={[guide.signupNote, guide.cost && guide.cost !== "Free" ? guide.cost : ""].filter(Boolean).join(" · ")}
              action={
                guide.signupUrl ? (
                  <a href={guide.signupUrl} target="_blank" rel="noopener noreferrer" className={ICON_LINK} data-attr={`listing-site-signup-${def.id}`} aria-label={`Open ${def.label} sign-up`} title={`Open ${def.label} sign-up`}>
                    <ExternalLink className="size-4" aria-hidden />
                  </a>
                ) : null
              }
            />
            <Step
              n={2}
              title="Copy your post"
              action={
                <>
                  <CopyIconAction label="Copy post" data-attr={`listing-site-copy-${def.id}`} disabled={!postText} onCopy={copyPost} />
                  {selectedId ? (
                    <a
                      href={`/api/manager/listing-channels/photos?propertyId=${encodeURIComponent(selectedId)}`}
                      download
                      className={ICON_LINK}
                      data-attr={`listing-site-photos-${def.id}`}
                      aria-label="Download photos"
                      title="Download photos"
                    >
                      <Download className="size-4" aria-hidden />
                    </a>
                  ) : null}
                </>
              }
            >
              {postText ? (
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-accent/40 p-3 text-xs text-foreground" data-attr="listing-site-guide-post">{postText}</pre>
              ) : null}
            </Step>
            <Step
              n={3}
              title="Post it"
              note={guide.createNote}
              action={
                guide.createUrl ? (
                  <a href={guide.createUrl} target="_blank" rel="noopener noreferrer" className={ICON_LINK} data-attr={`listing-site-create-${def.id}`} aria-label={`Open ${def.label}`} title={`Open ${def.label}`}>
                    <ExternalLink className="size-4" aria-hidden />
                  </a>
                ) : null
              }
            />
            <Step
              n={4}
              done={posted}
              title="Mark as posted"
              note={posted ? `Posted by you · ${shortDate(row?.postedAt)}` : undefined}
              action={
                posted ? (
                  <PortalIconAction icon={Undo2} label="Undo" data-attr={`listing-site-unmark-${def.id}`} disabled={busy || !canManage} onClick={() => write("mark-posted", { posted: false })} />
                ) : (
                  <Button variant="ghost" data-attr={`listing-site-mark-${def.id}`} disabled={busy || !canManage || !selectedId} onClick={() => write("mark-posted", { posted: true, ...(postedUrl.trim() ? { postedUrl: postedUrl.trim() } : {}) })}>
                    Mark
                  </Button>
                )
              }
            >
              {posted ? null : (
                <input
                  type="url"
                  value={postedUrl}
                  onChange={(e) => setPostedUrl(e.target.value)}
                  placeholder="Ad link (optional)"
                  aria-label="Ad link"
                  data-attr={`listing-site-posted-url-${def.id}`}
                  className="mt-2 w-full rounded-lg border border-border bg-card px-2 py-1 text-sm text-foreground"
                />
              )}
            </Step>
          </div>
        )}

        {guide.rules.length > 0 ? (
          <div data-attr="listing-site-guide-rules">
            <h3 className="text-sm font-medium text-foreground">Keep the account safe</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">
              {guide.rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
