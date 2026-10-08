#!/usr/bin/env node
// Record one product-shot scene for a growth reel.
//
// Signs in to the showcase manager (npm run app-store:seed) on a LOCAL dev server with Playwright,
// opens the route named in the scene's direction, optionally runs one action, records the page
// (deviceScaleFactor 2 at 540x960 = 1080x1920) and trims it to the scene's duration with the ffmpeg that
// ships with @remotion/renderer. Output: output/growth/<postId>/scene-<n>.mp4 (mp4 because the public
// `growth` bucket does not allow webm).
//
//   node scripts/growth-shots.mjs --post <id> --scene 1 --duration 5000 \
//     --direction "route:/portal/dashboard action:click[data-demo-target=approve]" [--base http://localhost:3007]
//
// direction format: `route:/portal/dashboard action:click[data-demo-target=approve]` -- the action is
// click or hover followed by a CSS selector, or scroll followed by pixels (`action:scroll600`); the action
// is optional. Refuses non-localhost bases unless --allow-remote.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_BASE = "http://localhost:3007";
export const VIEWPORT = { width: 540, height: 960 };

/** `route:/x action:click[sel]` -> { route, action }. Throws on a direction with no usable route. */
export function parseDirection(direction) {
  const text = String(direction ?? "").trim();
  const routeMatch = text.match(/(?:^|\s)route:(\/[^\s]*)/);
  if (!routeMatch) throw new Error(`direction needs "route:/path" (got: ${JSON.stringify(text.slice(0, 80))})`);
  const route = routeMatch[1];
  let action = null;
  const actionMatch = text.match(/(?:^|\s)action:(click|hover|scroll)(.*)$/s);
  if (actionMatch) {
    const type = actionMatch[1];
    const rest = actionMatch[2].trim();
    if (type === "scroll") {
      const px = Number(rest.replace(/^[[=:]|\]$/g, ""));
      if (!Number.isFinite(px) || rest === "") throw new Error("action:scroll needs a pixel number, e.g. action:scroll600");
      action = { type, px };
    } else {
      if (!rest) throw new Error(`action:${type} needs a CSS selector, e.g. action:${type}[data-demo-target=approve]`);
      action = { type, selector: rest };
    }
  } else if (/(?:^|\s)action:/.test(text)) {
    throw new Error("unsupported action (use click, hover or scroll)");
  }
  return { route, action };
}

export function isLocalBase(base) {
  try {
    const { hostname } = new URL(base);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

function readEnvLocal(key) {
  const file = resolve(REPO, ".env.local");
  if (!existsSync(file)) return "";
  const line = readFileSync(file, "utf8").split("\n").reverse().find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "") : "";
}

function parseArgs(argv) {
  const out = { base: DEFAULT_BASE, allowRemote: false, duration: 5000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--allow-remote") out.allowRemote = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
  }
  out.duration = Number(out.duration);
  out.scene = Number(out.scene ?? 0);
  return out;
}

// Same flow as scripts/ios-app-store-screenshots.mjs signIn (kept in step with it).
async function signIn(page, base, email, password) {
  await page.goto(`${base}/auth/sign-in`, { waitUntil: "load", timeout: 120_000 });
  await page.locator("input[type=email]").waitFor({ timeout: 120_000 });
  await page.fill("input[type=email]", email);
  await page.fill("input[type=password]", password);
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => /\/portal\/|choose-portal/.test(url.pathname), { timeout: 120_000 }).catch(() => {});
  if (page.url().includes("choose-portal")) {
    await page.getByText("Property", { exact: true }).first().click();
    await page.waitForURL((url) => url.pathname.includes("/portal/"), { timeout: 120_000 }).catch(() => {});
  }
  await page.waitForTimeout(2000);
  if (!page.url().includes("/portal/")) throw new Error(`sign-in as ${email} did not reach the manager portal (landed on ${page.url()})`);
}

async function hideDevNotices(page) {
  await page
    .addStyleTag({ content: "nextjs-portal, [data-nextjs-toast], [data-nextjs-dev-tools-button]{display:none!important}" })
    .catch(() => {});
}

async function settle(page) {
  await page.waitForLoadState("load").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
}

async function runAction(page, action) {
  if (!action) return;
  if (action.type === "click") await page.locator(action.selector).first().click({ timeout: 8000 });
  else if (action.type === "hover") await page.locator(action.selector).first().hover({ timeout: 8000 });
  else if (action.type === "scroll") await page.mouse.wheel(0, action.px);
}

/** ffmpeg ships inside @remotion/compositor; its dylibs resolve relative to cwd, so run it from there. */
export function ffmpegBinary() {
  const require = createRequire(import.meta.url);
  const dir = dirname(require.resolve(`@remotion/compositor-${process.platform}-${process.arch}/package.json`));
  return { dir, bin: resolve(dir, "ffmpeg") };
}
import { createRequire } from "node:module";

export function runFfmpeg(args) {
  const { dir, bin } = ffmpegBinary();
  const r = spawnSync(bin, args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status}): ${(r.stderr || "").slice(-600)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.post || args.direction == null) throw new Error("usage: growth-shots.mjs --post <id> --scene <n> --duration <ms> --direction <text> [--base url] [--allow-remote]");
  if (!isLocalBase(args.base) && !args.allowRemote) throw new Error(`refusing non-localhost base ${args.base} (pass --allow-remote to override)`);
  const { route, action } = parseDirection(args.direction);
  const { chromium } = await import("playwright");

  const email = process.env.SHOT_EMAIL || readEnvLocal("SHOT_EMAIL") || "manager2@test.proplane.local";
  const password = process.env.SHOT_PASSWORD || readEnvLocal("SHOT_PASSWORD") || "TestManager123!";
  const outDir = resolve(REPO, "output/growth", args.post);
  const rawDir = resolve(outDir, `.raw-${args.scene}`);
  rmSync(rawDir, { recursive: true, force: true });
  mkdirSync(rawDir, { recursive: true });
  const out = resolve(outDir, `scene-${args.scene}.mp4`);

  const browser = await chromium.launch();
  try {
    // 1) sign in + warm the route in a context that is NOT recorded.
    const auth = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const authPage = await auth.newPage();
    await signIn(authPage, args.base, email, password);
    await authPage.goto(`${args.base}${route}`, { waitUntil: "load", timeout: 120_000 });
    await settle(authPage);
    const state = await auth.storageState();
    await auth.close();

    // 2) record the scene with the saved session.
    const ctx = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      storageState: state,
      recordVideo: { dir: rawDir, size: VIEWPORT },
    });
    const page = await ctx.newPage();
    const t0 = Date.now();
    await page.goto(`${args.base}${route}`, { waitUntil: "load", timeout: 120_000 });
    await hideDevNotices(page);
    await settle(page);
    const leadMs = Date.now() - t0;
    await runAction(page, action);
    // Hold until the scene's duration has been recorded after the lead-in.
    await page.waitForTimeout(args.duration + 400);
    const video = page.video();
    await ctx.close();
    const raw = video ? await video.path() : resolve(rawDir, readdirSync(rawDir).find((f) => f.endsWith(".webm")));
    if (!existsSync(raw) || statSync(raw).size === 0) throw new Error("Playwright produced no video");

    const ss = Math.max(0, leadMs - 300) / 1000;
    mkdirSync(dirname(out), { recursive: true });
    runFfmpeg([
      "-y", "-ss", ss.toFixed(2), "-i", raw, "-t", (args.duration / 1000).toFixed(2),
      "-vf", "scale=1080:1920:flags=lanczos",
      "-r", "30",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "20", "-an", "-movflags", "+faststart", out,
    ]);
  } finally {
    await browser.close();
    rmSync(rawDir, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ ok: true, file: out, route, action }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`growth-shots: ${e.message}`);
    process.exit(1);
  });
}
