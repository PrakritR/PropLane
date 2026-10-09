"use client";

import { useCallback, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import { ToggleChips } from "@/components/ui/toggle-chips";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { formatPacificDate, pacificCalendarDateYmd, pacificStartOfDayMs } from "@/lib/pacific-time";
import { growthApi, type GrowthPostView } from "@/lib/growth/client";
import { GROWTH_PLATFORMS, type GrowthCaptions, type GrowthPlatform } from "@/lib/growth/types";
import { ReelStudio } from "@/components/portal/growth-reel-studio";
import {
  FORMAT_LABEL,
  GrowthErrorBanner,
  GrowthPublicationList,
  GrowthSkeletonBlocks,
  GrowthStatusPill,
  PLATFORM_LABEL,
  useGrowthLoad,
} from "@/components/portal/growth-shared";

/** ISO instant -> `YYYY-MM-DDTHH:mm` in Pacific, the value a datetime-local input wants. */
function toPacificInput(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const time = formatPacificDate(ms, { hour: "2-digit", minute: "2-digit", hour12: false }).replace(/^24:/, "00:");
  return `${pacificCalendarDateYmd(ms)}T${time}`;
}

/** Pacific wall-clock `YYYY-MM-DDTHH:mm` -> ISO instant. */
function fromPacificInput(value: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const start = pacificStartOfDayMs(m[1]!);
  if (start == null) return null;
  return new Date(start + Number(m[2]) * 3_600_000 + Number(m[3]) * 60_000).toISOString();
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={MODAL_FIELD_LABEL_CLASS}>{label}</span>
      {children}
    </label>
  );
}

function PhonePreview({ post }: { post: GrowthPostView }) {
  const platforms = GROWTH_PLATFORMS.filter((p) => post.platforms.includes(p));
  const [picked, setPicked] = useState<GrowthPlatform | null>(null);
  const active = picked && platforms.includes(picked) ? picked : (platforms[0] ?? null);
  const caption = active ? (post.captions[active] ?? "") : "";
  const label = active ? PLATFORM_LABEL[active] : "no platform";
  const image = (post.assets ?? []).find((a) => a.kind === "image" || a.kind === "shot");
  const empty = active ? `No ${PLATFORM_LABEL[active]} caption yet.` : "Select a platform to preview.";
  return (
    <div data-attr="admin-growth-preview">
      <p className={MODAL_FIELD_LABEL_CLASS} data-attr="admin-growth-preview-label">
        Preview &middot; {label}
      </p>
      {platforms.length > 1 ? (
        <div className="mb-2 flex flex-wrap gap-1" role="group" aria-label="Preview platform" data-attr="admin-growth-preview-platforms">
          {platforms.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={p === active}
              data-attr={`admin-growth-preview-platform-${p}`}
              onClick={() => setPicked(p)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                p === active ? "border-primary bg-primary text-white" : "border-border bg-card text-muted hover:text-foreground"
              }`}
            >
              {PLATFORM_LABEL[p]}
            </button>
          ))}
        </div>
      ) : null}
      {post.format === "text" ? (
        <div className="rounded-2xl border border-border bg-card p-4 text-sm leading-snug text-foreground" data-attr="admin-growth-preview-card">
          <b className="text-xs">PropLane</b>
          <p className="mt-1 whitespace-pre-line text-[13px]">{caption || empty}</p>
        </div>
      ) : (
        <div className="mx-auto w-[220px] rounded-[28px] border-4 border-foreground/80 bg-card p-1.5">
          <div
            className="relative flex aspect-[9/16] items-end overflow-hidden rounded-[20px] bg-gradient-to-br from-[#2863f0] to-[#0b1f6b] p-3 text-white"
            style={image ? { backgroundImage: `url(${image.publicUrl})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}
          >
            <div className="w-full rounded-lg bg-black/35 p-2 text-[10px] leading-snug backdrop-blur-sm">
              <b>proplane</b>
              <p className="mt-0.5 line-clamp-5 whitespace-pre-line opacity-90">{caption || empty}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function GrowthPostDetail({ postId }: { postId: string }) {
  const navigate = usePortalNavigate();
  const { data: post, error, loading, reload, setData: setPost } = useGrowthLoad(() => growthApi.getPost(postId));
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"post" | "reel">("post");

  const patch = useCallback(
    async (fields: Parameters<typeof growthApi.patchPost>[1]) => {
      setSaveState("saving");
      setActionError(null);
      const res = await growthApi.patchPost(postId, fields);
      if (!res.ok) {
        setSaveState("idle");
        setActionError(res.error);
        return;
      }
      setPost((prev: GrowthPostView | null) => (prev ? { ...prev, ...res.data } : res.data));
      setSaveState("saved");
    },
    [postId, setPost],
  );

  const run = async (key: string, fn: () => ReturnType<typeof growthApi.approve>, after?: () => void) => {
    setBusy(key);
    setActionError(null);
    const res = await fn();
    setBusy(null);
    if (!res.ok) {
      setActionError(res.error);
      return;
    }
    setPost((prev: GrowthPostView | null) => (prev ? { ...prev, ...res.data } : res.data));
    after?.();
  };

  if (loading) return <GrowthSkeletonBlocks count={4} />;
  if (error || !post) {
    return <GrowthErrorBanner message={error ?? "Post not found."} onRetry={reload} dataAttr="admin-growth-post-error" />;
  }

  const setLocal = (fields: Partial<GrowthPostView>) => setPost({ ...post, ...fields });
  const locked = post.status === "published" || post.status === "archived" || post.status === "publishing";
  const setCaption = (p: GrowthPlatform, value: string) => setLocal({ captions: { ...post.captions, [p]: value } as GrowthCaptions });

  return (
    <div className="space-y-4" data-attr="admin-growth-post">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" className="h-9 px-2 text-sm" data-attr="admin-growth-post-back" onClick={() => navigate("/admin/growth")}>
          <ArrowLeft className="mr-1 size-4" aria-hidden /> Queue
        </Button>
        <GrowthStatusPill status={post.status} />
        <span className="text-xs text-muted">{FORMAT_LABEL[post.format]}</span>
        <span className="ml-auto text-xs text-muted" aria-live="polite" data-attr="admin-growth-post-save-state">
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}
        </span>
      </div>
      {actionError ? <GrowthErrorBanner message={actionError} dataAttr="admin-growth-post-action-error" /> : null}
      {post.reviewNote ? (
        <p className="rounded-2xl border border-border bg-accent/30 px-4 py-2 text-sm text-foreground" data-attr="admin-growth-post-review-note">
          <b>Note:</b> {post.reviewNote}
        </p>
      ) : null}
      {(post.publications ?? []).some((p) => p.status === "published" || p.status === "failed") ? (
        <div className="rounded-2xl border border-border bg-card px-4 py-3" data-attr="admin-growth-post-publications">
          <span className={MODAL_FIELD_LABEL_CLASS}>Publications</span>
          <GrowthPublicationList publications={post.publications ?? []} />
        </div>
      ) : null}
      {post.format !== "text" ? (
        <div className="flex gap-1" role="tablist" aria-label="Post sections" data-attr="admin-growth-post-tabs">
          {([["post", "Post"], ["reel", "Reel studio"]] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              data-attr={`admin-growth-post-tab-${k}`}
              onClick={() => setTab(k)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${tab === k ? "border-primary bg-primary text-white" : "border-border bg-card text-muted hover:text-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {tab === "reel" && post.format !== "text" ? (
        <ReelStudio key={post.id} post={post} locked={locked} onPost={(p) => setPost(p)} />
      ) : (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="space-y-4">
          <Field label="Title (internal)">
            <Input
              value={post.title}
              disabled={locked}
              data-attr="admin-growth-post-title"
              onChange={(e) => setLocal({ title: e.target.value })}
              onBlur={() => void patch({ title: post.title })}
            />
          </Field>
          <Field label="Hook (first 2 seconds)">
            <Textarea
              rows={2}
              value={post.hook ?? ""}
              disabled={locked}
              data-attr="admin-growth-post-hook"
              onChange={(e) => setLocal({ hook: e.target.value })}
              onBlur={() => void patch({ hook: post.hook ?? "" })}
            />
          </Field>
          <Field label="Script">
            <Textarea
              rows={7}
              value={post.script ?? ""}
              disabled={locked}
              data-attr="admin-growth-post-script"
              onChange={(e) => setLocal({ script: e.target.value })}
              onBlur={() => void patch({ script: post.script ?? "" })}
            />
          </Field>
          {post.platforms.length === 0 ? <p className="text-xs text-muted">Select a platform to write its caption.</p> : null}
          {GROWTH_PLATFORMS.filter((p) => post.platforms.includes(p)).map((p) => (
            <Field key={p} label={`Caption · ${PLATFORM_LABEL[p]}`}>
              <Textarea
                rows={5}
                value={post.captions[p] ?? ""}
                disabled={locked}
                data-attr={`admin-growth-post-caption-${p}`}
                onChange={(e) => setCaption(p, e.target.value)}
                onBlur={() => void patch({ captions: post.captions })}
              />
            </Field>
          ))}
          <div>
            <span className={MODAL_FIELD_LABEL_CLASS}>Platforms</span>
            <ToggleChips
              label="Platforms"
              dataAttr="admin-growth-post-platforms"
              disabled={locked}
              options={GROWTH_PLATFORMS.map((p) => ({ value: p, label: PLATFORM_LABEL[p] }))}
              selected={post.platforms}
              onChange={(next) => {
                setLocal({ platforms: next });
                void patch({ platforms: next });
              }}
            />
          </div>
          <div>
            <span className={MODAL_FIELD_LABEL_CLASS}>Scenes (read-only)</span>
            {post.scenes.length === 0 ? (
              <p className="text-xs text-muted" data-attr="admin-growth-post-scenes-empty">No scenes for this post.</p>
            ) : (
              <ol className="space-y-1" data-attr="admin-growth-post-scenes">
                {post.scenes.map((s) => (
                  <li key={s.index} className="rounded-xl border border-border bg-card px-3 py-2 text-xs">
                    <b>
                      Scene {s.index + 1} &middot; {Math.round(s.startMs / 1000)}-{Math.round(s.endMs / 1000)}s &middot; {s.kind}
                    </b>
                    <p className="mt-0.5 text-muted">{s.text}</p>
                    {s.direction ? <p className="mt-0.5 text-muted/80">{s.direction}</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </div>
          <Field label="Schedule (Pacific)">
            <Input
              type="datetime-local"
              value={toPacificInput(post.scheduledFor)}
              disabled={locked}
              data-attr="admin-growth-post-schedule"
              onChange={(e) => {
                const iso = fromPacificInput(e.target.value);
                setLocal({ scheduledFor: iso });
              }}
              onBlur={() => void patch({ scheduledFor: post.scheduledFor })}
            />
          </Field>
          {noteOpen ? (
            <div className="space-y-2" data-attr="admin-growth-post-note-form">
              <Textarea rows={3} value={note} placeholder="What should change?" data-attr="admin-growth-post-note" onChange={(e) => setNote(e.target.value)} />
              <Button
                type="button"
                variant="outline"
                data-attr="admin-growth-post-note-send"
                disabled={!note.trim()}
                loading={busy === "back"}
                onClick={() => void run("back", () => growthApi.sendBack(postId, note.trim()), () => { setNoteOpen(false); setNote(""); })}
              >
                Send back
              </Button>
            </div>
          ) : null}
          {!locked ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                data-attr="admin-growth-post-approve"
                loading={busy === "approve"}
                onClick={() => void run("approve", () => growthApi.approve(postId, post.scheduledFor))}
              >
                Approve and schedule
              </Button>
              <Button type="button" variant="outline" data-attr="admin-growth-post-send-back" onClick={() => setNoteOpen((v) => !v)}>
                Send back with a note
              </Button>
              <Button
                type="button"
                variant="outline"
                data-attr="admin-growth-post-regenerate"
                loading={busy === "regen"}
                onClick={() => void run("regen", () => growthApi.regenerate(postId))}
              >
                Regenerate caption
              </Button>
              <Button
                type="button"
                variant="danger"
                data-attr="admin-growth-post-archive"
                loading={busy === "archive"}
                onClick={() => void run("archive", () => growthApi.archive(postId), () => navigate("/admin/growth"))}
              >
                Archive
              </Button>
            </div>
          ) : null}
        </div>
        <PhonePreview post={post} />
      </div>
      )}
    </div>
  );
}
