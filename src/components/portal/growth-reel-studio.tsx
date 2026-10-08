"use client";

import { useEffect, useState } from "react";
import { Film, Plus, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import { growthApi, type GrowthPostView, type GrowthVideoStatus } from "@/lib/growth/client";
import { MAX_SCENES } from "@/lib/growth/scenes";
import type { GrowthAsset, GrowthScene } from "@/lib/growth/types";
import { GrowthErrorBanner } from "@/components/portal/growth-shared";

type SceneState = "ready" | "missing" | "fallback";

const KIND_LABEL: Record<GrowthScene["kind"], string> = { generated: "Generated", template: "Template", shot: "Product shot", still: "Still" };

/** Asset for a scene: by meta.sceneIndex when the renderer wrote it (TODO inferred), else by order among clip/shot assets. */
function sceneAsset(assets: GrowthAsset[], scene: GrowthScene, position: number): GrowthAsset | null {
  const pool = assets.filter((a) => a.kind === "clip" || a.kind === "shot");
  return pool.find((a) => Number(a.meta?.sceneIndex) === scene.index) ?? (pool.every((a) => a.meta?.sceneIndex == null) ? (pool[position] ?? null) : null);
}

function sceneState(scene: GrowthScene, asset: GrowthAsset | null, fellBack: boolean): SceneState {
  if (fellBack) return "fallback";
  if (scene.kind === "template" || scene.kind === "still") return "ready";
  return asset ? "ready" : "missing";
}

/**
 * Why each scene degraded on the last render, by scene index. The renderer writes them to the final video
 * asset's `meta.fallbacks` (a degraded scene saves no asset row of its own).
 */
function fallbackReasons(video: GrowthAsset | undefined): Map<number, string> {
  const out = new Map<number, string>();
  const raw = video?.meta?.fallbacks;
  if (!Array.isArray(raw)) return out;
  for (const f of raw as Array<{ sceneIndex?: unknown; reason?: unknown }>) {
    if (typeof f?.sceneIndex === "number") out.set(f.sceneIndex, typeof f.reason === "string" && f.reason ? f.reason : "fell back to a template scene");
  }
  return out;
}

const STATE_TONE = { ready: "success", missing: "warning", fallback: "info" } as const;

function renumber(scenes: GrowthScene[]): GrowthScene[] {
  return scenes.map((s, i) => ({ ...s, index: i }));
}

export function ReelStudio({ post, onPost, locked }: { post: GrowthPostView; onPost: (p: GrowthPostView) => void; locked: boolean }) {
  const [scenes, setScenes] = useState<GrowthScene[]>(post.scenes);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<GrowthVideoStatus | null>(null);
  const [busy, setBusy] = useState<"save" | "render" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runbook, setRunbook] = useState<string | null>(null);
  const assets = post.assets ?? [];
  const video = [...assets].reverse().find((a) => a.kind === "video");
  // Carousel/image posts render Card stills, not a reel: saveFinalAsset marks them meta.final.
  const stills = assets
    .filter((a) => a.kind === "image" && a.meta?.final === true)
    .sort((a, b) => Number(a.meta?.sceneIndex ?? 0) - Number(b.meta?.sceneIndex ?? 0));
  const fallbacks = fallbackReasons(video);

  useEffect(() => {
    let live = true;
    void growthApi.videoStatus().then((r) => {
      if (live && r.ok) setStatus(r.data);
    });
    return () => {
      live = false;
    };
  }, []);

  const edit = (i: number, fields: Partial<GrowthScene>) => {
    setScenes((prev) => prev.map((s, j) => (j === i ? { ...s, ...fields } : s)));
    setDirty(true);
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    const res = await growthApi.saveScenes(post.id, renumber(scenes));
    setBusy(null);
    if (!res.ok) return setError(res.error);
    setDirty(false);
    setNotice("Scenes saved.");
    setScenes(res.data.scenes);
    onPost({ ...post, ...res.data, assets: post.assets });
  };

  const render = async () => {
    setBusy("render");
    setError(null);
    setNotice(null);
    setRunbook(null);
    const res = await growthApi.render(post.id);
    setBusy(null);
    if (res.ok) return setNotice("Render requested. The cockpit Mac picks it up on its next run.");
    setError(res.error);
    if (res.status === 501 || res.status === 409) setRunbook(`node scripts/growth-render.mjs ${post.id}`);
  };

  const cost = status?.estimatePerReelUsd;
  const missingKeys = status ? [!status.clip.keyPresent && (status.clip.driver === "kling" ? "FAL_KEY" : "GEMINI_API_KEY"), !status.voice.keyPresent && "ELEVENLABS_API_KEY"].filter(Boolean) : [];

  return (
    <div className="space-y-4" data-attr="admin-growth-reel-studio">
      {error ? <GrowthErrorBanner message={error} dataAttr="admin-growth-reel-error" /> : null}
      {runbook ? (
        <p className="rounded-2xl border border-border bg-card px-4 py-2 text-xs text-muted" data-attr="admin-growth-reel-runbook">
          Run it by hand: <code className="font-mono text-foreground">{runbook}</code>
        </p>
      ) : null}
      {notice ? <p className="text-xs text-muted" aria-live="polite" data-attr="admin-growth-reel-notice">{notice}</p> : null}
      <p className="text-xs text-muted" data-attr="admin-growth-reel-cost">
        {cost
          ? `Estimated cost per reel: $${cost.clip.toFixed(2)} (${status?.clip.driver === "kling" ? "Kling" : "Veo"}) · voice $${cost.voice.toFixed(2)}`
          : "Estimated cost per reel: loading"}
      </p>
      {missingKeys.length > 0 ? (
        <p
          className="rounded-2xl border border-[var(--status-pending-fg)]/30 bg-[var(--status-pending-bg)] px-4 py-2 text-xs text-[var(--status-pending-fg)]"
          data-attr="admin-growth-reel-keys"
        >
          Missing {missingKeys.join(", ")}. Scenes that need it fall back to a template scene with the same text.
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_220px]">
        <div className="space-y-2">
          <span className={MODAL_FIELD_LABEL_CLASS}>Scenes</span>
          {scenes.length === 0 ? <p className="text-xs text-muted" data-attr="admin-growth-reel-empty">No scenes yet. Add one.</p> : null}
          <ol className="space-y-2" data-attr="admin-growth-reel-scenes">
            {scenes.map((s, i) => {
              const asset = sceneAsset(assets, s, i);
              const fellBack = fallbacks.get(s.index);
              const state = sceneState(s, asset, fellBack !== undefined);
              return (
                <li key={i} className="flex gap-3 rounded-2xl border border-border bg-card p-3" data-attr="admin-growth-reel-scene" data-state={state}>
                  <div
                    className="flex h-24 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-[#2863f0] to-[#0b1f6b] text-white"
                  >
                    {asset?.publicUrl && /\.(png|jpe?g|webp)(\?|$)/i.test(asset.publicUrl) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={asset.publicUrl} alt="" className="h-full w-full object-cover" />
                    ) : asset?.publicUrl ? (
                      <video src={asset.publicUrl} muted playsInline preload="metadata" className="h-full w-full object-cover" />
                    ) : (
                      <Film className="size-5 opacity-80" aria-hidden />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <b>Scene {i + 1}</b>
                      <Badge tone="neutral">{KIND_LABEL[s.kind]}</Badge>
                      <span className="text-muted">
                        {(s.startMs / 1000).toFixed(1)}-{(s.endMs / 1000).toFixed(1)}s
                      </span>
                      <Badge tone={STATE_TONE[state]}>{state}</Badge>
                    </div>
                    {fellBack ? (
                      <p className="text-[11px] text-muted" data-attr="admin-growth-reel-fallback-reason">
                        Last render used a template scene: {fellBack}
                      </p>
                    ) : null}
                    <Input value={s.text} disabled={locked} aria-label={`Scene ${i + 1} text`} onChange={(e) => edit(i, { text: e.target.value })} />
                    <Textarea
                      rows={2}
                      value={s.direction}
                      disabled={locked}
                      aria-label={`Scene ${i + 1} direction`}
                      placeholder={s.kind === "shot" ? "Route and action to record, e.g. /dashboard/inbox then open a thread" : "Direction"}
                      onChange={(e) => edit(i, { direction: e.target.value })}
                    />
                    {!locked ? (
                      <div className="flex flex-wrap gap-2">
                        {s.kind !== "shot" ? (
                          <Button type="button" variant="outline" className="h-7 px-2 text-[11px]" data-attr="admin-growth-reel-swap-shot" onClick={() => edit(i, { kind: "shot" })}>
                            Swap for product shot
                          </Button>
                        ) : null}
                        {s.kind !== "template" ? (
                          <Button type="button" variant="outline" className="h-7 px-2 text-[11px]" data-attr="admin-growth-reel-make-template" onClick={() => edit(i, { kind: "template" })}>
                            Make it a template scene
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-7 px-2 text-[11px]"
                          data-attr="admin-growth-reel-remove"
                          onClick={() => {
                            setScenes((prev) => renumber(prev.filter((_, j) => j !== i)));
                            setDirty(true);
                          }}
                        >
                          Remove
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
          {!locked ? (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                data-attr="admin-growth-reel-add"
                disabled={scenes.length >= MAX_SCENES}
                onClick={() => {
                  const last = scenes[scenes.length - 1];
                  const start = last?.endMs ?? 0;
                  setScenes(renumber([...scenes, { index: scenes.length, kind: "template", startMs: start, endMs: start + 3000, text: "", direction: "" }]));
                  setDirty(true);
                }}
              >
                <Plus className="mr-1 size-4" aria-hidden /> Add scene
              </Button>
              <Button type="button" data-attr="admin-growth-reel-save" disabled={!dirty} loading={busy === "save"} onClick={() => void save()}>
                Save scenes
              </Button>
              <Button type="button" variant="outline" data-attr="admin-growth-reel-render" disabled={dirty} loading={busy === "render"} onClick={() => void render()}>
                <RefreshCw className="mr-1 size-4" aria-hidden /> Render
              </Button>
            </div>
          ) : null}
        </div>
        <div data-attr="admin-growth-reel-player">
          <span className={MODAL_FIELD_LABEL_CLASS}>{post.format === "reel" ? "Rendered reel" : "Rendered stills"}</span>
          {video ? (
            <div className="mx-auto w-[200px] overflow-hidden rounded-[22px] border-4 border-foreground/80 bg-black">
              <video src={video.publicUrl} muted autoPlay loop playsInline controls className="aspect-[9/16] w-full object-cover" />
            </div>
          ) : stills.length > 0 ? (
            <ol className="mx-auto w-[200px] space-y-2" data-attr="admin-growth-reel-stills">
              {stills.map((a, i) => (
                <li key={a.id} className="overflow-hidden rounded-2xl border border-border bg-black">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.publicUrl} alt={stills.length > 1 ? `Slide ${i + 1}` : "Rendered still"} className="aspect-[4/5] w-full object-cover" />
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-muted">Not rendered yet. Render once the scenes look right.</p>
          )}
        </div>
      </div>
    </div>
  );
}
