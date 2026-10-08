"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Modal, ModalFooter, MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import { ToggleChips } from "@/components/ui/toggle-chips";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { formatPacificDate } from "@/lib/pacific-time";
import { growthApi, type GrowthPostView } from "@/lib/growth/client";
import type { GrowthPublication } from "@/lib/growth/types";
import { GROWTH_FORMATS, GROWTH_PLATFORMS, type GrowthFormat, type GrowthPlatform } from "@/lib/growth/types";
import {
  FORMAT_LABEL,
  GrowthChip,
  GrowthErrorBanner,
  GrowthFormatChip,
  GrowthSkeletonBlocks,
  PLATFORM_LABEL,
  PLATFORM_SHORT,
  useGrowthLoad,
} from "@/components/portal/growth-shared";

const COLUMNS = [
  { id: "ideas", label: "Ideas", statuses: ["idea"] },
  { id: "drafted", label: "Drafted", statuses: ["drafted"] },
  { id: "review", label: "Needs your review", statuses: ["review"] },
  { id: "scheduled", label: "Scheduled", statuses: ["approved", "scheduled", "publishing", "failed"] },
  { id: "published", label: "Published", statuses: ["published"] },
] as const;

function metricsLine(post: GrowthPostView): string | null {
  const pubs = post.publications ?? [];
  const live = pubs.filter((p) => p.status === "published");
  if (!live.length) return post.publishedAt ? `Published ${formatPacificDate(post.publishedAt, { month: "short", day: "numeric" })}` : null;
  return live.map((p) => PLATFORM_SHORT[p.platform]).join(" · ");
}

function summaryLine(post: GrowthPostView): string | null {
  const text = post.hook ?? post.script ?? null;
  if (post.status === "scheduled" && post.scheduledFor) {
    return `${formatPacificDate(post.scheduledFor, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
  }
  return text;
}

export function GrowthNewPostModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = usePortalNavigate();
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState<GrowthFormat>("reel");
  const [platforms, setPlatforms] = useState<GrowthPlatform[]>(["instagram"]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    const res = await growthApi.createPost({ title: title.trim(), format, platforms });
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onClose();
    navigate(`/admin/growth/post/${encodeURIComponent(res.data.id)}`);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New post"
      dataAttr="admin-growth-new-post-modal"
      footer={
        <ModalFooter>
          <Button
            type="button"
            data-attr="admin-growth-new-post-create"
            disabled={!title.trim() || platforms.length === 0}
            loading={saving}
            onClick={() => void submit()}
          >
            Create post
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className={MODAL_FIELD_LABEL_CLASS}>Title (internal)</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Leak at 11pm. What happens next?" data-attr="admin-growth-new-post-title" />
        </label>
        <label className="block">
          <span className={MODAL_FIELD_LABEL_CLASS}>Format</span>
          <Select value={format} onChange={(e) => setFormat(e.target.value as GrowthFormat)} data-attr="admin-growth-new-post-format" aria-label="Format">
            {GROWTH_FORMATS.map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABEL[f]}
              </option>
            ))}
          </Select>
        </label>
        <div>
          <span className={MODAL_FIELD_LABEL_CLASS}>Platforms</span>
          <ToggleChips
            label="Platforms"
            dataAttr="admin-growth-new-post-platforms"
            options={GROWTH_PLATFORMS.map((p) => ({ value: p, label: PLATFORM_LABEL[p] }))}
            selected={platforms}
            onChange={setPlatforms}
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-[var(--status-overdue-fg)]" data-attr="admin-growth-new-post-error">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

function PostCard({ post, onOpen }: { post: GrowthPostView; onOpen: () => void }) {
  const summary = summaryLine(post);
  const metrics = post.status === "published" ? metricsLine(post) : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-attr="admin-growth-queue-card"
      data-status={post.status}
      className="w-full rounded-2xl border border-border bg-card p-3 text-left transition hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <p className="text-sm font-semibold text-foreground">{post.title}</p>
      {summary ? <p className="mt-1 line-clamp-1 text-xs text-muted">{summary}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <GrowthFormatChip format={post.format} />
        {GROWTH_PLATFORMS.filter((p) => post.platforms.includes(p)).map((p) => (
          <GrowthChip key={p} on>
            {PLATFORM_SHORT[p]}
          </GrowthChip>
        ))}
      </div>
      {metrics ? <p className="mt-2 text-[11px] font-medium text-muted">{metrics}</p> : null}
    </button>
  );
}

export function GrowthQueueTab() {
  const navigate = usePortalNavigate();
  const { data: posts, error, loading, reload } = useGrowthLoad(() => growthApi.listPosts());
  const [drafting, setDrafting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const visible = useMemo(() => (posts ?? []).filter((p) => p.status !== "archived"), [posts]);
  const failed = useMemo(() => visible.filter((p) => p.status === "failed"), [visible]);
  // The list route carries no publications; fetch them for failed posts so the banner can name the platform.
  const [failedPubs, setFailedPubs] = useState<Record<string, GrowthPublication[]>>({});
  const failedKey = failed.map((p) => p.id).join(",");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const id of failedKey ? failedKey.split(",") : []) {
        const res = await growthApi.getPost(id);
        if (!cancelled && res.ok) setFailedPubs((prev) => ({ ...prev, [id]: res.data.publications ?? [] }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [failedKey]);

  const draftNow = async () => {
    setDrafting(true);
    setActionError(null);
    const res = await growthApi.draftNow();
    setDrafting(false);
    if (!res.ok) setActionError(res.error);
    else reload();
  };

  const retry = async (publicationId: string) => {
    setRetrying(publicationId);
    setActionError(null);
    const res = await growthApi.retryPublication(publicationId);
    setRetrying(null);
    if (!res.ok) setActionError(res.error);
    else reload();
  };

  const open = (id: string) => navigate(`/admin/growth/post/${encodeURIComponent(id)}`);

  return (
    <div className="space-y-3" data-attr="admin-growth-queue">
      {error ? <GrowthErrorBanner message={error} onRetry={reload} dataAttr="admin-growth-queue-error" /> : null}
      {actionError ? <GrowthErrorBanner message={actionError} dataAttr="admin-growth-queue-action-error" /> : null}
      {failed.map((post) => {
        const bad = (failedPubs[post.id] ?? post.publications ?? []).filter((p) => p.status === "failed");
        const platforms = bad.length ? bad.map((p) => PLATFORM_LABEL[p.platform]).join(", ") : "A platform";
        return (
          <div
            key={post.id}
            role="alert"
            data-attr="admin-growth-failed-banner"
            className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--status-overdue-fg)]/30 bg-[var(--status-overdue-bg)] px-4 py-3 text-sm text-[var(--status-overdue-fg)]"
          >
            <span>
              <b>{platforms} publish failed</b> for &ldquo;{post.title}&rdquo;
              {bad[0]?.error ? `: ${bad[0].error}` : "."} Other platforms are unaffected.
            </span>
            <span className="flex gap-2">
              {bad[0] ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 px-3 text-xs"
                  data-attr="admin-growth-failed-retry"
                  loading={retrying === bad[0].id}
                  onClick={() => void retry(bad[0]!.id)}
                >
                  Retry
                </Button>
              ) : null}
              <Button type="button" variant="outline" className="h-8 px-3 text-xs" data-attr="admin-growth-failed-open" onClick={() => open(post.id)}>
                Open post
              </Button>
            </span>
          </div>
        );
      })}
      {loading ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-5" data-attr="admin-growth-queue-loading">
          {COLUMNS.map((c) => (
            <GrowthSkeletonBlocks key={c.id} count={2} />
          ))}
        </div>
      ) : null}
      {posts && visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-accent/25 px-6 py-12 text-center" data-attr="admin-growth-queue-empty">
          <p className="text-sm font-semibold text-foreground">No posts yet.</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted">
            Connect an account, then press New post or let tonight&rsquo;s run draft the first week.
          </p>
          <Button type="button" className="mt-4 min-h-11" data-attr="admin-growth-draft-first-week" loading={drafting} onClick={() => void draftNow()}>
            Draft my first week
          </Button>
        </div>
      ) : null}
      {posts && visible.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-5" data-attr="admin-growth-board">
          {COLUMNS.map((col) => {
            const items = visible.filter((p) => (col.statuses as readonly string[]).includes(p.status));
            return (
              <section key={col.id} className="min-w-0" data-attr={`admin-growth-column-${col.id}`} aria-label={col.label}>
                <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">
                  {col.label} · {items.length}
                </h3>
                <div className="space-y-2">
                  {items.map((post) => (
                    <PostCard key={post.id} post={post} onOpen={() => open(post.id)} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
