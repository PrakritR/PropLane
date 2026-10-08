import "server-only";

import { mapAsset, must, type GrowthDb } from "../db.server";
import type { GrowthAsset } from "../types";
import { MissingKeyError, type ClipAspect, type ClipResult, type VideoDriver, type VoiceResult } from "./driver-types";

export const GROWTH_BUCKET = "growth";

export type AssetKind = GrowthAsset["kind"];

/** Idempotency key for an asset row: one row per {postId, sceneIndex, kind}. Post-level assets use sceneIndex -1. */
export type AssetKey = { postId: string; kind: AssetKind; sceneIndex: number };

export type SaveAssetInput = AssetKey & {
  buffer: Buffer;
  /** File name under `<postId>/` in the bucket, e.g. `scene-1.mp4`. */
  fileName: string;
  contentType: string;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  meta?: Record<string, unknown>;
};

/** Where assets live. The Supabase implementation uploads to the public `growth` bucket; tests use a fake. */
export interface AssetStore {
  list(postId: string): Promise<GrowthAsset[]>;
  save(input: SaveAssetInput): Promise<GrowthAsset>;
}

export function assetSceneIndex(a: Pick<GrowthAsset, "meta">): number {
  const v = a.meta?.sceneIndex;
  return typeof v === "number" ? v : -1;
}

export function findAsset(assets: GrowthAsset[], key: AssetKey): GrowthAsset | undefined {
  return assets.find((a) => a.postId === key.postId && a.kind === key.kind && assetSceneIndex(a) === key.sceneIndex);
}

export function supabaseAssetStore(db: GrowthDb): AssetStore {
  return {
    async list(postId) {
      const rows = must(await db.from("growth_assets").select("*").eq("post_id", postId).order("created_at"), "list assets");
      return (rows as Record<string, unknown>[]).map(mapAsset);
    },
    async save(input) {
      const storagePath = `${input.postId}/${input.fileName}`;
      const up = await db.storage.from(GROWTH_BUCKET).upload(storagePath, input.buffer, { contentType: input.contentType, upsert: true });
      if (up.error) throw new Error(`upload ${storagePath}: ${up.error.message}`);
      const publicUrl = db.storage.from(GROWTH_BUCKET).getPublicUrl(storagePath).data.publicUrl;
      const existing = findAsset(await this.list(input.postId), input);
      const row = {
        post_id: input.postId,
        kind: input.kind,
        storage_path: storagePath,
        public_url: publicUrl,
        width: input.width ?? null,
        height: input.height ?? null,
        duration_ms: input.durationMs ?? null,
        meta: { ...(input.meta ?? {}), sceneIndex: input.sceneIndex },
      };
      const res = existing
        ? await db.from("growth_assets").update(row).eq("id", existing.id).select("*").single()
        : await db.from("growth_assets").insert(row).select("*").single();
      return mapAsset(must(res, "save asset") as Record<string, unknown>);
    },
  };
}

// ── Driver resolution ───────────────────────────────────────────────────────

type ClipFn = VideoDriver["generateClip"];
type VoiceFn = VideoDriver["synthesizeVoice"];

/** A driver module that could not be imported. `notFound` separates "not installed" from a broken module. */
export type DriverLoadFailure = { specifier: string; message: string; notFound: boolean };

export type ResolvedDrivers = {
  /** Clip drivers in preference order; a driver whose module is missing is simply absent. */
  clips: Array<{ id: string; generateClip: ClipFn }>;
  voice: VoiceFn | null;
  /** Import failures, so an empty `clips` is not reported as a missing key. */
  loadFailures?: DriverLoadFailure[];
};

export type ModuleLoader = (specifier: string) => Promise<Record<string, unknown>>;

const defaultLoader: ModuleLoader = (specifier) => import(/* webpackIgnore: true */ /* @vite-ignore */ specifier);

/**
 * Resolve the vendor drivers by dynamic import. A module that is not there (or does not export the function)
 * is skipped, so the render still runs with template scenes. GROWTH_VIDEO_DRIVER picks which clip driver is first.
 * Every import failure is logged and kept on `loadFailures`: a broken module must not read as a missing key.
 */
export async function resolveDrivers(
  loader: ModuleLoader = defaultLoader,
  log?: (line: string) => void,
): Promise<ResolvedDrivers> {
  const loadFailures: DriverLoadFailure[] = [];
  const load = async (spec: string) => {
    try {
      return await loader(spec);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const notFound = (e as { code?: string } | null)?.code === "ERR_MODULE_NOT_FOUND" || /cannot find module/i.test(message);
      loadFailures.push({ specifier: spec, message, notFound });
      log?.(`driver ${spec} ${notFound ? "not installed" : "failed to load"}: ${message}`);
      return null;
    }
  };
  const [veo, kling, eleven] = await Promise.all([load("./veo.server"), load("./kling.server"), load("./elevenlabs.server")]);
  const clips: ResolvedDrivers["clips"] = [];
  if (typeof veo?.generateClip === "function") clips.push({ id: "veo", generateClip: veo.generateClip as ClipFn });
  if (typeof kling?.generateClip === "function") clips.push({ id: "kling", generateClip: kling.generateClip as ClipFn });
  if (process.env.GROWTH_VIDEO_DRIVER?.trim().toLowerCase() === "kling") clips.reverse();
  const voice = typeof eleven?.synthesizeVoice === "function" ? (eleven.synthesizeVoice as VoiceFn) : null;
  return { clips, voice, loadFailures };
}

/** Try each clip driver in order. Throws MissingKeyError only when no driver could run for lack of a key. */
export async function generateClipWithFallback(
  drivers: ResolvedDrivers,
  prompt: string,
  opts: { durationMs: number; aspect: ClipAspect },
): Promise<ClipResult & { driver: string }> {
  let missing: MissingKeyError | null = null;
  for (const d of drivers.clips) {
    try {
      return { ...(await d.generateClip(prompt, opts)), driver: d.id };
    } catch (e) {
      if (e instanceof MissingKeyError) {
        missing ??= e;
        continue;
      }
      throw e;
    }
  }
  if (missing) throw missing;
  const broken = (drivers.loadFailures ?? []).filter((f) => !f.notFound);
  if (broken.length) throw new Error(`no clip driver loaded: ${broken.map((f) => `${f.specifier}: ${f.message}`).join("; ")}`);
  throw new MissingKeyError("GEMINI_API_KEY");
}

export async function synthesizeVoiceOrNull(drivers: ResolvedDrivers, text: string): Promise<VoiceResult | null> {
  if (!drivers.voice) return null;
  try {
    return await drivers.voice(text);
  } catch (e) {
    if (e instanceof MissingKeyError) return null;
    throw e;
  }
}
