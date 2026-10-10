"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, ExternalLink, MessageSquare, RefreshCw, SkipForward, Trash2 } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter, MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { growthApi } from "@/lib/growth/client";
import {
  ENGAGE_PLATFORMS,
  tallyEngage,
  type EngageItem,
  type EngagePlatform,
  type GrowthKeyword,
  type WatchKind,
  type WatchlistEntry,
} from "@/lib/growth/engage/types";
import { pacificDate, shiftDate } from "@/lib/growth/engage/dates";
import { cn } from "@/lib/utils";
import { GrowthErrorBanner, GrowthSkeletonBlocks } from "@/components/portal/growth-shared";

/** A stored link opens only when it is https; anything else (`javascript:`, `data:`, junk) does nothing. */
function openHttpsUrl(raw: string | null | undefined) {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return;
  }
  if (url.protocol !== "https:") return;
  window.open(url.href, "_blank", "noopener,noreferrer");
}

const PLATFORM_NAME: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  x: "X",
  reddit: "Reddit",
  facebook: "Facebook",
};

function dateLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

function EngageRow({ item, onChange }: { item: EngageItem; onChange: (next: EngageItem) => void }) {
  const [draft, setDraft] = useState(item.draft ?? "");
  const [error, setError] = useState<string | null>(null);
  const muted = item.status !== "open";

  const patch = async (p: { status?: EngageItem["status"]; draft?: string }) => {
    setError(null);
    const res = await growthApi.patchEngage(item.id, p);
    if (res.ok) onChange(res.data);
    else setError(res.error);
  };

  return (
    <li
      className={cn("rounded-2xl border border-border bg-card p-3", muted && "opacity-60")}
      data-attr="growth-engage-row"
      data-status={item.status}
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-foreground/70"
          role="img"
          aria-label={PLATFORM_NAME[item.platform] ?? item.platform}
        >
          <MessageSquare className="size-[18px]" strokeWidth={1.75} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{item.target}</p>
          <p className="truncate text-xs text-muted">{item.why ?? ""}</p>
        </div>
        <div className="flex shrink-0 items-center">
          <PortalIconAction
            icon={ExternalLink}
            label="Open"
            data-attr={`growth-engage-open-${item.id}`}
            onClick={() => openHttpsUrl(item.url)}
          />
          <PortalIconAction
            icon={Check}
            label={item.status === "done" ? "Mark open" : "Done"}
            tone="primary"
            active={item.status === "done"}
            data-attr={`growth-engage-done-${item.id}`}
            onClick={() => void patch({ status: item.status === "done" ? "open" : "done" })}
          />
          <PortalIconAction
            icon={SkipForward}
            label={item.status === "skipped" ? "Mark open" : "Skip"}
            data-attr={`growth-engage-skip-${item.id}`}
            onClick={() => void patch({ status: item.status === "skipped" ? "open" : "skipped" })}
          />
        </div>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== (item.draft ?? "")) void patch({ draft });
        }}
        rows={3}
        aria-label={`Drafted comment for ${item.target}`}
        data-attr={`growth-engage-draft-${item.id}`}
        className="mt-2 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      />
      {error ? <p role="alert" className="mt-1 text-xs font-medium text-[var(--status-overdue-fg)]">{error}</p> : null}
    </li>
  );
}

type AddKind = WatchKind | "keyword";

const ADD_TITLE: Record<AddKind, string> = {
  engage: "Add account to engage",
  follow: "Add account to follow",
  collab: "Add collab creator",
  keyword: "Add keyword",
};

function AddModal({ kind, onClose, onAdded }: { kind: AddKind | null; onClose: () => void; onAdded: () => void }) {
  const [platform, setPlatform] = useState<EngagePlatform>("instagram");
  const [handle, setHandle] = useState("");
  const [reply, setReply] = useState("");
  const [link, setLink] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isKeyword = kind === "keyword";

  const save = async () => {
    if (!kind) return;
    setSaving(true);
    setError(null);
    const res = isKeyword
      ? await growthApi.addKeyword({ keyword: handle.trim(), reply: reply.trim() || null, link: link.trim() || null })
      : await growthApi.addWatch({ platform, handle: handle.trim(), kind: kind as WatchKind });
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setHandle("");
    setReply("");
    setLink("");
    onAdded();
    onClose();
  };

  return (
    <Modal
      open={kind !== null}
      title={kind ? ADD_TITLE[kind] : ADD_TITLE.keyword}
      onClose={onClose}
      preview={null}
      contextPanel={null}
      footer={
        <ModalFooter className="w-full gap-2">
          <Button type="button" variant="primary" className="ml-auto rounded-full" disabled={saving || !handle.trim()} onClick={() => void save()} data-attr="growth-engage-add-save">
            {saving ? "Saving…" : "Add"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-3" data-attr="growth-engage-add-modal">
        {!isKeyword ? (
          <FieldSingleSelect
            label="Platform"
            options={ENGAGE_PLATFORMS.map((p) => ({ value: p, label: PLATFORM_NAME[p] }))}
            value={platform}
            onChange={(next) => setPlatform(next as EngagePlatform)}
            dataAttr="growth-engage-add-platform"
          />
        ) : null}
        <label className="block">
          <span className={MODAL_FIELD_LABEL_CLASS}>{isKeyword ? "Keyword" : "Handle"}</span>
          <Input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder={isKeyword ? "DEMO" : "@handle"} data-attr="growth-engage-add-handle" />
        </label>
        {isKeyword ? (
          <>
            <label className="block">
              <span className={MODAL_FIELD_LABEL_CLASS}>Reply</span>
              <Input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Here is the link to book a demo." />
            </label>
            <label className="block">
              <span className={MODAL_FIELD_LABEL_CLASS}>Link</span>
              <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" />
            </label>
          </>
        ) : null}
        {error ? <p role="alert" className="text-xs font-medium text-[var(--status-overdue-fg)]">{error}</p> : null}
      </div>
    </Modal>
  );
}

function Group({
  title,
  count,
  onAdd,
  addLabel,
  dataAttr,
  children,
}: {
  title: string;
  count: number;
  onAdd: () => void;
  addLabel: string;
  dataAttr: string;
  children: React.ReactNode;
}) {
  return (
    <details className="rounded-2xl border border-border bg-card" data-attr={dataAttr} open={count > 0 ? true : undefined}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-foreground">
        <span>
          {title} · {count}
        </span>
        <PortalPrimaryIconAction
          label={addLabel}
          data-attr={`${dataAttr}-add`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onAdd();
          }}
        />
      </summary>
      <div className="border-t border-border/70 px-2 py-1">{children}</div>
    </details>
  );
}

export function GrowthEngageTab() {
  const { showToast } = useAppUi();
  const today = useMemo(() => pacificDate(), []);
  const [date, setDate] = useState(today);
  const [items, setItems] = useState<EngageItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [watch, setWatch] = useState<WatchlistEntry[]>([]);
  const [keywords, setKeywords] = useState<GrowthKeyword[]>([]);
  const [adding, setAdding] = useState<AddKind | null>(null);

  const loadItems = useCallback(async (d: string) => {
    const res = await growthApi.listEngage(d);
    if (res.ok) {
      setItems(res.data.items);
      setError(null);
    } else {
      setItems(null);
      setError(res.error);
    }
  }, []);

  const loadLists = useCallback(async () => {
    const [w, k] = await Promise.all([growthApi.listWatchlist(), growthApi.listKeywords()]);
    if (w.ok) setWatch(w.data);
    if (k.ok) setKeywords(k.data);
  }, []);

  useEffect(() => {
    void loadItems(date);
  }, [date, loadItems]);
  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  // A build reports through the toast, never through the list's own error state.
  const buildNow = async () => {
    setBuilding(true);
    const res = await growthApi.buildEngageNow();
    setBuilding(false);
    if (!res.ok) {
      showToast(res.error);
      return;
    }
    const { inserted, skipped, stoppedEarly } = res.data;
    const said = [`Added ${inserted}`, `skipped ${skipped}`];
    if (stoppedEarly) said.push("stopped early, run again");
    showToast(said.join(" · "));
    setDate(today);
    await loadItems(today);
  };

  const ordered = useMemo(() => {
    const list = items ?? [];
    return [...list.filter((i) => i.status === "open"), ...list.filter((i) => i.status !== "open")];
  }, [items]);

  // One tally, over the rows actually on screen, because this is the side that edits them.
  const counts = useMemo(() => tallyEngage(items ?? []), [items]);

  const engage = watch.filter((w) => w.kind === "engage");
  const follow = watch.filter((w) => w.kind === "follow");
  const collab = watch.filter((w) => w.kind === "collab");

  const applyItem = useCallback((next: EngageItem) => {
    setItems((cur) => (cur ?? []).map((i) => (i.id === next.id ? next : i)));
  }, []);

  const removeWatch = async (id: string) => {
    const res = await growthApi.deleteWatch(id);
    if (res.ok) setWatch((cur) => cur.filter((w) => w.id !== id));
  };
  const removeKeyword = async (id: string) => {
    const res = await growthApi.deleteKeyword(id);
    if (res.ok) setKeywords((cur) => cur.filter((k) => k.id !== id));
  };

  const watchRows = (rows: WatchlistEntry[], empty: string) =>
    rows.length === 0 ? (
      <p className="px-2 py-4 text-center text-sm text-muted">{empty}</p>
    ) : (
      rows.map((w) => (
        <div key={w.id} className="flex items-center gap-2 px-2 py-1.5" data-attr="growth-watchlist-row">
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
            {w.handle} · {PLATFORM_NAME[w.platform] ?? w.platform}
          </span>
          {w.url ? (
            <PortalIconAction icon={ExternalLink} label="Open" onClick={() => openHttpsUrl(w.url)} />
          ) : null}
          <PortalIconAction icon={Trash2} label="Remove" tone="danger" data-attr={`growth-watchlist-remove-${w.id}`} onClick={() => void removeWatch(w.id)} />
        </div>
      ))
    );

  return (
    <div className="space-y-5" data-attr="growth-engage">
      <p className="text-sm text-foreground" data-attr="growth-engage-intro">
        Growth without a ban. Auto-follow and auto-like bots violate Instagram, TikTok and LinkedIn terms and get brand accounts restricted. The engine will not
        follow or like on your behalf. Instead it builds you a 10-minute daily list, drafts each comment, and you tap through on your phone.
      </p>

      <section className="space-y-3" data-attr="growth-engage-today">
        <div className="flex items-center gap-1">
          <h3 className="min-w-0 flex-1 text-sm font-semibold text-foreground">
            Today&apos;s list · {counts.open} open · {counts.done} done · {dateLabel(date)}
          </h3>
          <PortalIconAction icon={ChevronLeft} label="Previous day" data-attr="growth-engage-date-prev" onClick={() => setDate((d) => shiftDate(d, -1))} />
          <PortalIconAction icon={ChevronRight} label="Next day" data-attr="growth-engage-date-next" onClick={() => setDate((d) => shiftDate(d, 1))} />
          <PortalIconAction icon={RefreshCw} label="Build now" tone="primary" disabled={building} data-attr="growth-engage-build-now" onClick={() => void buildNow()} />
        </div>
        {error ? (
          <GrowthErrorBanner message={error} onRetry={() => void loadItems(date)} dataAttr="growth-engage-error" />
        ) : items === null ? (
          <GrowthSkeletonBlocks count={3} />
        ) : ordered.length === 0 ? (
          <EmptyState title="No list for this day" description="Use Build now to draft today's list." />
        ) : (
          <ul className="space-y-2">
            {ordered.map((item) => (
              <EngageRow
                key={item.id}
                item={item}
                onChange={applyItem}
              />
            ))}
          </ul>
        )}
      </section>

      <div className="space-y-3">
        <Group
          title="Engage by hand"
          count={engage.length}
          onAdd={() => setAdding("engage")}
          addLabel="Add account to engage"
          dataAttr="growth-group-engage"
        >
          {watchRows(engage, "No accounts to engage yet.")}
        </Group>
        <Group title="Follow by hand" count={follow.length} onAdd={() => setAdding("follow")} addLabel="Add account to follow" dataAttr="growth-group-follow">
          {watchRows(follow, "No accounts to follow yet.")}
        </Group>
        <Group title="Comment-to-DM keywords" count={keywords.length} onAdd={() => setAdding("keyword")} addLabel="Add keyword" dataAttr="growth-group-keywords">
          {keywords.length === 0 ? (
            <p className="px-2 py-4 text-center text-sm text-muted">No keywords yet.</p>
          ) : (
            keywords.map((k) => (
              <div key={k.id} className="flex items-center gap-2 px-2 py-1.5" data-attr="growth-keyword-row">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {k.keyword}
                  {k.link ? ` → ${k.link}` : ""}
                </span>
                <PortalIconAction icon={Trash2} label="Remove" tone="danger" data-attr={`growth-keyword-remove-${k.id}`} onClick={() => void removeKeyword(k.id)} />
              </div>
            ))
          )}
        </Group>
        <Group title="Collab shortlist" count={collab.length} onAdd={() => setAdding("collab")} addLabel="Add collab creator" dataAttr="growth-group-collab">
          {watchRows(collab, "No creators shortlisted yet.")}
        </Group>
      </div>

      <AddModal kind={adding} onClose={() => setAdding(null)} onAdded={() => void loadLists()} />
    </div>
  );
}
