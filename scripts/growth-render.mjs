#!/usr/bin/env node
// Render growth posts to media (Phase 2 of the growth engine; see docs/agents/growth-engine.md).
//
//   node scripts/growth-render.mjs <postId>     render one post
//   node scripts/growth-render.mjs --pending    every review/approved/scheduled reel/carousel/image post
//                                               that is not yet rendered for its current content
//   options: --base http://localhost:3007   dev server the product shots are recorded against
//
// For each post: build the render plan, fill what is missing (AI clips and voice when keys exist, product
// shots with Playwright, otherwise template scenes), bundle remotion/growth once (cached in
// output/growth/.bundle), render output/growth/<id>/final.mp4 (Reel) or final.png / final-<n>.png (Card),
// upload to the public `growth` bucket, insert the asset row and set growth_posts.meta.rendered.
// It NEVER changes approval status. Dev/test database only (the service client refuses the live project).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The growth modules are TypeScript with "@/" aliases (tsx resolves them) and import "server-only", which
// throws outside Next; a resolve hook below turns that marker into an empty module. (The react-server
// condition is not an option: it would hand Remotion a React without createContext.)
if (!process.env.GROWTH_RENDER_CHILD) {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", cwd: REPO, env: { ...process.env, GROWTH_RENDER_CHILD: "1" } },
  );
  process.exit(r.status ?? 1);
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only" || specifier === "client-only") return { url: pathToFileURL(resolve(REPO, "tests/stubs/server-only.ts")).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const ENV_FILE = resolve(REPO, ".env.local");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const args = process.argv.slice(2);
const pending = args.includes("--pending");
const baseIdx = args.indexOf("--base");
const baseUrl = baseIdx >= 0 ? args[baseIdx + 1] : process.env.GROWTH_SHOTS_BASE || "http://localhost:3007";
const postArg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--base");
if (!pending && !postArg) {
  console.error("usage: node scripts/growth-render.mjs <postId> | --pending [--base http://localhost:3007]");
  process.exit(2);
}

const { growthDb } = await import("../src/lib/growth/db.server.ts");
const plan = await import("../src/lib/growth/video/render-plan.server.ts");
const assets = await import("../src/lib/growth/video/assets.server.ts");
const { captionTrack } = await import("../src/lib/growth/video/captions.server.ts");
const { bundle } = await import("@remotion/bundler");
const { renderMedia, renderStill, selectComposition } = await import("@remotion/renderer");

const OUT_ROOT = resolve(REPO, "output/growth");
const BUNDLE_DIR = join(OUT_ROOT, ".bundle");
const SRC_DIR = resolve(REPO, "remotion/growth");
const log = (line) => console.log(`[growth-render] ${line}`);

function sourceHash() {
  const h = createHash("sha256");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(`${p}:${st.size}:${st.mtimeMs}`);
    }
  };
  walk(SRC_DIR);
  const cap = resolve(REPO, "src/lib/growth/video/captions.server.ts");
  h.update(`${statSync(cap).size}:${statSync(cap).mtimeMs}`);
  return h.digest("hex");
}

// Render with the Chromium that Playwright already installed for scripts/growth-shots.mjs: no second browser
// download (Remotion's own headless shell download is blocked on some networks). GROWTH_BROWSER overrides.
let browserPromise = null;
function getBrowser() {
  browserPromise ??= (async () => {
    if (process.env.GROWTH_BROWSER) return process.env.GROWTH_BROWSER;
    const { chromium } = await import("playwright");
    return chromium.executablePath();
  })();
  return browserPromise;
}

let bundlePromise = null;
function getBundle() {
  bundlePromise ??= (async () => {
    mkdirSync(OUT_ROOT, { recursive: true });
    const hashFile = join(OUT_ROOT, ".bundle-hash");
    const hash = sourceHash();
    if (existsSync(join(BUNDLE_DIR, "index.html")) && existsSync(hashFile) && readFileSync(hashFile, "utf8") === hash) {
      log("bundle cache hit");
      return BUNDLE_DIR;
    }
    log("bundling remotion/growth");
    const url = await bundle({
      entryPoint: join(SRC_DIR, "index.ts"),
      outDir: BUNDLE_DIR,
      publicDir: join(SRC_DIR, "public"),
    });
    writeFileSync(hashFile, hash);
    return url;
  })();
  return bundlePromise;
}

// Remotion serves the bundle on a port from a shared range; on a busy dev machine another process can win it
// between the probe and the bind ("got no response"). One retry picks a fresh port.
async function withRetry(label, fn) {
  try {
    return await fn();
  } catch (e) {
    log(`${label} failed once (${e instanceof Error ? e.message : e}); retrying`);
    return fn();
  }
}

async function renderPost(db, store, postId) {
  const renderPlan = await plan.buildRenderPlan(postId, { db, store });
  const { post } = renderPlan;
  if (!plan.RENDER_FORMATS.includes(post.format)) throw new Error(`format ${post.format} has no render`);
  log(`post ${postId} (${post.format}, "${post.title}")`);
  const outDir = join(OUT_ROOT, postId);
  mkdirSync(outDir, { recursive: true });
  const signature = plan.renderSignature(post);
  const serveUrl = await getBundle();
  const browserExecutable = await getBrowser();
  let primary;

  if (post.format === "reel") {
    const m = await plan.materializePlan(renderPlan, { store, baseUrl, log });
    const composition = await withRetry("select Reel", () => selectComposition({ serveUrl, id: "Reel", inputProps: m.props, browserExecutable }));
    const file = join(outDir, "final.mp4");
    await withRetry("render Reel", () => renderMedia({ composition, serveUrl, codec: "h264", outputLocation: file, inputProps: m.props, browserExecutable, logLevel: "warn" }));
    const durationMs = Math.round((composition.durationInFrames / composition.fps) * 1000);
    const captions = m.props.words?.length
      ? captionTrack(m.props.words)
      : m.props.scenes.filter((s) => s.text.trim()).map((s) => ({ text: s.text.trim(), startMs: s.startMs, endMs: s.endMs }));
    primary = await plan.saveFinalAsset(store, {
      postId, kind: "video", buffer: readFileSync(file), fileName: "final.mp4", contentType: "video/mp4",
      width: composition.width, height: composition.height, durationMs,
      meta: {
        captions, captionMode: m.props.words?.length ? "karaoke" : "scene",
        sceneAssetIds: m.sceneAssetIds, voiceAssetId: m.voiceAssetId, fallbacks: m.fallbacks, signature,
      },
    });
    log(`rendered ${file} (${statSync(file).size} bytes, ${durationMs}ms)`);
  } else {
    const slides = post.format === "carousel" && post.scenes.length ? post.scenes : [null];
    for (let i = 0; i < slides.length; i++) {
      const props = {
        title: post.title, hook: post.hook, body: slides[i]?.text ?? null, index: i, total: slides.length,
        brand: { ...plan.BRAND },
      };
      const composition = await withRetry("select Card", () => selectComposition({ serveUrl, id: "Card", inputProps: props, browserExecutable }));
      const name = slides.length > 1 ? `final-${i + 1}.png` : "final.png";
      const file = join(outDir, name);
      await withRetry("render Card", () => renderStill({ composition, serveUrl, output: file, inputProps: props, browserExecutable, logLevel: "warn" }));
      const saved = await plan.saveFinalAsset(store, {
        postId, kind: "image", buffer: readFileSync(file), fileName: name, contentType: "image/png",
        width: composition.width, height: composition.height, index: i, meta: { signature, slide: i + 1, slides: slides.length },
      });
      primary ??= saved;
      log(`rendered ${file}`);
    }
  }
  await plan.markRendered(db, post, signature);
  return primary;
}

const db = growthDb();
const store = assets.supabaseAssetStore(db);
const ids = pending ? await plan.listPendingPostIds(db) : [postArg];
log(pending ? `${ids.length} pending post(s)` : `post ${postArg}`);
let failed = 0;
for (const id of ids) {
  try {
    const asset = await renderPost(db, store, id);
    console.log(JSON.stringify({ ok: true, postId: id, assetId: asset.id, kind: asset.kind, url: asset.publicUrl, durationMs: asset.durationMs }));
  } catch (e) {
    failed++;
    console.error(`[growth-render] ${id} failed: ${e instanceof Error ? e.message : e}`);
  }
}
process.exit(failed ? 1 : 0);
