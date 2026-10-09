import "server-only";

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createHash } from "node:crypto";

import { growthDb, mapPost, must, type GrowthDb } from "../db.server";
import { RENDER_FORMATS, RENDER_STATUSES } from "../types";
import type { GrowthAsset, GrowthPost, GrowthScene } from "../types";
import { DEFAULT_END_CARD_MS, type ReelProps, type ReelScene, type ReelWord } from "../../../../remotion/growth/types";
import {
  findAsset,
  generateClipWithFallback,
  resolveDrivers,
  supabaseAssetStore,
  synthesizeVoiceOrNull,
  type AssetStore,
  type ResolvedDrivers,
} from "./assets.server";
import { normalizeWords } from "./captions.server";
import { MissingKeyError } from "./driver-types";

export { RENDER_FORMATS, RENDER_STATUSES };
export const BRAND = { mark: "brand/proplane-mark.svg", blue: "#2863f0" } as const;

export type SceneAction = "reuse" | "generate" | "shoot" | "template";

export type SceneNeed = {
  scene: GrowthScene;
  /** reuse = an asset row already exists; generate/shoot = missing, call the driver / script; template = Remotion-only. */
  action: SceneAction;
  asset?: GrowthAsset;
};

export type VoiceNeed = { action: "reuse" | "synthesize" | "skip"; text: string; asset?: GrowthAsset };

export type RenderPlan = {
  post: GrowthPost;
  needs: SceneNeed[];
  voice: VoiceNeed;
  assets: GrowthAsset[];
};

/** Stable fingerprint of what a render depends on, so an edited post is re-rendered by --pending. */
export function renderSignature(post: Pick<GrowthPost, "title" | "hook" | "script" | "scenes" | "format">): string {
  return createHash("sha256")
    .update(JSON.stringify([post.format, post.title, post.hook, post.script, post.scenes]))
    .digest("hex")
    .slice(0, 16);
}

export function voiceText(post: Pick<GrowthPost, "script" | "scenes">): string {
  const script = post.script?.trim();
  if (script) return script;
  return post.scenes.map((s) => s.text.trim()).filter(Boolean).join(" ");
}

/** Pure decision step: what is missing for each scene. No IO, so it is unit-tested directly. */
export function planFromPost(post: GrowthPost, assets: GrowthAsset[]): RenderPlan {
  const needs: SceneNeed[] = post.scenes.map((scene) => {
    if (scene.kind === "generated" || scene.kind === "shot") {
      const kind = scene.kind === "generated" ? "clip" : "shot";
      const asset = findAsset(assets, { postId: post.id, kind, sceneIndex: scene.index, sceneId: scene.id });
      if (asset) return { scene, action: "reuse", asset };
      return { scene, action: scene.kind === "generated" ? "generate" : "shoot" };
    }
    if (scene.kind === "still") {
      const asset = findAsset(assets, { postId: post.id, kind: "image", sceneIndex: scene.index, sceneId: scene.id });
      return asset ? { scene, action: "reuse", asset } : { scene, action: "template" };
    }
    return { scene, action: "template" };
  });
  const text = voiceText(post);
  const voiceAsset = findAsset(assets, { postId: post.id, kind: "voice", sceneIndex: -1 });
  const voice: VoiceNeed =
    post.format !== "reel" || !text ? { action: "skip", text } : voiceAsset ? { action: "reuse", text, asset: voiceAsset } : { action: "synthesize", text };
  return { post, needs, voice, assets };
}

export type PlanDeps = { db?: GrowthDb; store?: AssetStore };

export async function loadPost(postId: string, db: GrowthDb): Promise<GrowthPost & { meta: Record<string, unknown> }> {
  const { data, error } = await db.from("growth_posts").select("*").eq("id", postId).maybeSingle();
  if (error) throw new Error(`load post: ${error.message}`);
  if (!data) throw new Error(`growth post ${postId} not found`);
  const row = data as Record<string, unknown>;
  return { ...mapPost(row), meta: (row.meta as Record<string, unknown> | null) ?? {} };
}

export async function buildRenderPlan(postId: string, deps: PlanDeps = {}): Promise<RenderPlan> {
  const db = deps.db ?? growthDb();
  const store = deps.store ?? supabaseAssetStore(db);
  const post = await loadPost(postId, db);
  return planFromPost(post, await store.list(postId));
}

// ── Materializing ───────────────────────────────────────────────────────────

export type ShootInput = { postId: string; scene: GrowthScene; baseUrl: string };
export type MaterializeDeps = {
  store: AssetStore;
  drivers?: ResolvedDrivers;
  /** Records a product shot; returns the mp4 bytes. Default spawns scripts/growth-shots.mjs. */
  shoot?: (input: ShootInput) => Promise<Buffer>;
  fetchBuffer?: (url: string) => Promise<Buffer>;
  baseUrl?: string;
  log?: (line: string) => void;
};

export type MaterializedPlan = {
  props: ReelProps;
  sceneAssetIds: Array<string | null>;
  voiceAssetId: string | null;
  fallbacks: Array<{ sceneIndex: number; from: string; to: "template"; reason: string }>;
};

const REPO = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
/** No external step in the pipeline may hang the serial nightly run: every one is bounded. */
const DOWNLOAD_TIMEOUT_MS = 120_000;
const SHOOT_TIMEOUT_MS = 5 * 60_000;

/** A stable file name per scene, so a renumbered timeline never overwrites another scene's media. */
export function sceneFileStem(scene: Pick<GrowthScene, "id" | "index">): string {
  return `scene-${scene.id?.trim() || scene.index}`;
}

export function defaultShoot({ postId, scene, baseUrl }: ShootInput): Promise<Buffer> {
  const out = resolve(REPO, "output/growth", postId, `${sceneFileStem(scene)}.mp4`);
  return new Promise((ok, fail) => {
    const child = spawn(
      process.execPath,
      [
        resolve(REPO, "scripts/growth-shots.mjs"),
        "--post", postId,
        "--scene", String(scene.index),
        "--duration", String(Math.max(1000, scene.endMs - scene.startMs)),
        "--direction", scene.direction,
        "--base", baseUrl,
      ],
      { stdio: ["ignore", "pipe", "pipe"], cwd: REPO },
    );
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`growth-shots timed out after ${SHOOT_TIMEOUT_MS / 1000}s`));
    }, SHOOT_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return fail(new Error(`growth-shots exited ${code}: ${err.trim().slice(-400)}`));
      readFile(out).then(ok, fail);
    });
  });
}

async function defaultFetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`download ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Fill one scene. Never throws for a missing key or a failed driver/shot: the scene falls back to a template. */
export async function materializeScene(
  postId: string,
  need: SceneNeed,
  deps: MaterializeDeps,
): Promise<{ scene: ReelScene; assetId: string | null; fallback?: MaterializedPlan["fallbacks"][number] }> {
  const { scene } = need;
  const fallbackTo = (reason: string) => ({
    scene: { ...scene, kind: "template" as const, fallback: "template" as const },
    assetId: null,
    fallback: { sceneIndex: scene.index, from: scene.kind, to: "template" as const, reason },
  });

  if (need.action === "reuse" && need.asset) {
    return {
      scene: { ...scene, assetUrl: need.asset.publicUrl, assetDurationMs: need.asset.durationMs ?? undefined },
      assetId: need.asset.id,
    };
  }
  if (need.action === "template") {
    return { scene: scene.kind === "still" ? fallbackTo("no image asset").scene : { ...scene }, assetId: null };
  }

  const fetchBuffer = deps.fetchBuffer ?? defaultFetchBuffer;
  try {
    if (need.action === "generate") {
      const drivers = deps.drivers ?? (await resolveDrivers(undefined, deps.log));
      const clip = await generateClipWithFallback(drivers, scene.direction || scene.text, {
        durationMs: Math.max(1000, scene.endMs - scene.startMs),
        aspect: "9:16",
      });
      const buffer = clip.buffer ?? (clip.url ? await fetchBuffer(clip.url) : null);
      if (!buffer) throw new Error("driver returned neither url nor buffer");
      const saved = await deps.store.save({
        postId, kind: "clip", sceneIndex: scene.index, sceneId: scene.id, buffer,
        fileName: `${sceneFileStem(scene)}.mp4`, contentType: "video/mp4",
        width: 1080, height: 1920, durationMs: clip.durationMs,
        meta: { ...clip.meta, driver: clip.driver },
      });
      return {
        scene: { ...scene, assetUrl: saved.publicUrl, assetDurationMs: clip.durationMs ?? undefined },
        assetId: saved.id,
      };
    }
    // shoot
    const buffer = await (deps.shoot ?? defaultShoot)({ postId, scene, baseUrl: deps.baseUrl ?? "http://localhost:3007" });
    const saved = await deps.store.save({
      postId, kind: "shot", sceneIndex: scene.index, sceneId: scene.id, buffer,
      fileName: `${sceneFileStem(scene)}.mp4`, contentType: "video/mp4",
      width: 1080, height: 1920, durationMs: scene.endMs - scene.startMs,
      meta: { direction: scene.direction },
    });
    return {
      scene: { ...scene, assetUrl: saved.publicUrl, assetDurationMs: saved.durationMs ?? undefined },
      assetId: saved.id,
    };
  } catch (e) {
    const reason = e instanceof MissingKeyError ? `missing key ${e.envVar}` : msg(e);
    deps.log?.(`scene ${scene.index} (${scene.kind}) -> template: ${reason}`);
    return fallbackTo(reason);
  }
}

/** Run every missing piece, then return the Remotion props. Safe to re-run: existing assets are reused. */
export async function materializePlan(plan: RenderPlan, deps: MaterializeDeps): Promise<MaterializedPlan> {
  const { post } = plan;
  const drivers = deps.drivers ?? (await resolveDrivers(undefined, deps.log));
  const d = { ...deps, drivers };
  const scenes: ReelScene[] = [];
  const sceneAssetIds: Array<string | null> = [];
  const fallbacks: MaterializedPlan["fallbacks"] = [];
  for (const need of plan.needs) {
    const r = await materializeScene(post.id, need, d);
    scenes.push(r.scene);
    sceneAssetIds.push(r.assetId);
    if (r.fallback) fallbacks.push(r.fallback);
  }

  let voiceUrl: string | undefined;
  let voiceAssetId: string | null = null;
  let words: ReelWord[] | undefined;
  let voiceMs = 0;
  if (plan.voice.action === "reuse" && plan.voice.asset) {
    voiceUrl = plan.voice.asset.publicUrl;
    voiceAssetId = plan.voice.asset.id;
    words = normalizeWords(plan.voice.asset.meta.words as ReelWord[] | undefined);
    voiceMs = plan.voice.asset.durationMs ?? 0;
  } else if (plan.voice.action === "synthesize") {
    try {
      const v = await synthesizeVoiceOrNull(drivers, plan.voice.text);
      if (v) {
        const saved = await deps.store.save({
          postId: post.id, kind: "voice", sceneIndex: -1, buffer: v.buffer,
          fileName: "voice.mp3", contentType: "audio/mpeg", durationMs: v.durationMs,
          meta: { words: v.words },
        });
        voiceUrl = saved.publicUrl;
        voiceAssetId = saved.id;
        words = normalizeWords(v.words);
        voiceMs = v.durationMs;
      } else {
        deps.log?.("voice skipped: no driver or key; per-scene captions");
      }
    } catch (e) {
      deps.log?.(`voice failed (${msg(e)}); per-scene captions`);
    }
  }

  const props: ReelProps = {
    post: { id: post.id, title: post.title, hook: post.hook },
    scenes,
    voiceUrl,
    words: words && words.length ? words : undefined,
    brand: { ...BRAND },
    endCardMs: DEFAULT_END_CARD_MS,
  };
  if (voiceMs) props.totalMs = voiceMs + 600;
  return { props, sceneAssetIds, voiceAssetId, fallbacks };
}

// ── Finalize & pending ──────────────────────────────────────────────────────

export type FinalizeInput = {
  postId: string;
  kind: "video" | "image";
  buffer: Buffer;
  fileName: string;
  contentType: string;
  width: number;
  height: number;
  durationMs?: number;
  /** Slide number for carousel stills, 0 otherwise. */
  index?: number;
  meta: Record<string, unknown>;
};

/** Upload the render and record the asset (idempotent per post/index/kind). Never touches approval status. */
export async function saveFinalAsset(store: AssetStore, input: FinalizeInput): Promise<GrowthAsset> {
  return store.save({
    postId: input.postId, kind: input.kind, sceneIndex: 1000 + (input.index ?? 0),
    buffer: input.buffer, fileName: input.fileName, contentType: input.contentType,
    width: input.width, height: input.height, durationMs: input.durationMs ?? null,
    meta: { ...input.meta, final: true },
  });
}

export async function markRendered(db: GrowthDb, post: GrowthPost, signature: string): Promise<void> {
  const row = must(await db.from("growth_posts").select("meta").eq("id", post.id).single(), "read post meta");
  const meta: Record<string, unknown> = {
    ...((row as { meta?: Record<string, unknown> }).meta ?? {}),
    rendered: true,
    renderSignature: signature,
    renderedAt: new Date().toISOString(),
  };
  delete meta.renderRequested;
  delete meta.renderRequestedAt;
  const res = await db.from("growth_posts").update({ meta }).eq("id", post.id);
  if (res.error) throw new Error(`mark rendered (growth_posts.meta column applied?): ${res.error.message}`);
}

/**
 * Posts the nightly job should render: review/approved/scheduled, a rendered format, and either not rendered
 * for their current content or explicitly requested from the Reel studio (`meta.renderRequested`, cleared by
 * `markRendered`).
 */
export async function listPendingPostIds(db: GrowthDb = growthDb()): Promise<string[]> {
  const rows = must(
    await db.from("growth_posts").select("*").in("status", RENDER_STATUSES).in("format", RENDER_FORMATS).order("created_at"),
    "list pending",
  ) as Array<Record<string, unknown>>;
  return rows
    .filter((r) => {
      const meta = (r.meta as Record<string, unknown> | null) ?? {};
      if (meta.renderRequested === true) return true;
      return !(meta.rendered === true && meta.renderSignature === renderSignature(mapPost(r)));
    })
    .map((r) => r.id as string);
}
