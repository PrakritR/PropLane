#!/usr/bin/env node
/**
 * Merge required PropLane OAuth redirect URLs into a Supabase project's auth config.
 *
 * Usage:
 *   node scripts/sync-supabase-oauth-redirect-urls.mjs --project-ref qahnczmilgptcedaqype
 *   node scripts/sync-supabase-oauth-redirect-urls.mjs --project-ref emstjswhotsnyksqhqyf --dry-run
 *
 * Requires a Supabase personal access token in SUPABASE_ACCESS_TOKEN or macOS Keychain
 * ("Supabase CLI" generic password).
 */
import { execSync } from "node:child_process";

const PRODUCTION_ORIGINS = [
  "https://prop-lane.space",
  "https://www.prop-lane.space",
  "https://axis-seattle-housing.com",
  "https://www.axis-seattle-housing.com",
];

const LOCAL_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3009",
  "http://localhost:3010",
  "http://localhost:3011",
];

const NATIVE_CALLBACKS = [
  "space.proplane.app://auth/callback",
  "space.proplane.app://auth/callback/partner-pricing",
  "space.proplane.app://auth/callback/resident-signup",
  "space.proplane.app://auth/callback/vendor-signup",
  "space.proplane.app://auth/callback/**",
];

function authPaths(origin) {
  const base = origin.replace(/\/$/, "");
  return [
    `${base}/auth/callback`,
    `${base}/auth/callback/partner-pricing`,
    `${base}/auth/callback/resident-signup`,
    `${base}/auth/callback/vendor-signup`,
  ];
}

function requiredRedirectUrls({ includeLocal = false } = {}) {
  const origins = [...PRODUCTION_ORIGINS];
  if (includeLocal) origins.push(...LOCAL_ORIGINS);
  const urls = new Set();
  for (const origin of origins) {
    for (const path of authPaths(origin)) urls.add(path);
  }
  for (const native of NATIVE_CALLBACKS) urls.add(native);
  // Wildcards for production hosts (Supabase supports ** on some plans).
  urls.add("https://prop-lane.space/**");
  urls.add("https://www.prop-lane.space/**");
  return [...urls].sort();
}

function readAccessToken() {
  if (process.env.SUPABASE_ACCESS_TOKEN?.trim()) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  try {
    return execSync('security find-generic-password -s "Supabase CLI" -w', { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  let projectRef = null;
  let dryRun = false;
  let includeLocal = false;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--include-local") includeLocal = true;
    else if (arg === "--project-ref") {
      projectRef = argv[++i]?.trim() ?? null;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`usage: node scripts/sync-supabase-oauth-redirect-urls.mjs --project-ref <ref> [--include-local] [--dry-run]`);
      process.exit(0);
    }
  }
  if (!projectRef) {
    console.error("Missing --project-ref");
    process.exit(1);
  }
  return { projectRef, dryRun, includeLocal };
}

async function main() {
  const { projectRef, dryRun, includeLocal } = parseArgs(process.argv);
  const token = readAccessToken();
  if (!token) {
    console.error("No Supabase access token. Set SUPABASE_ACCESS_TOKEN or log in via Supabase CLI.");
    process.exit(1);
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const getRes = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth`, { headers });
  if (!getRes.ok) {
    console.error(`Failed to read auth config (${getRes.status}):`, await getRes.text());
    process.exit(1);
  }
  const current = await getRes.json();
  const existing = String(current.uri_allow_list ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = [...new Set([...existing, ...requiredRedirectUrls({ includeLocal })])].sort();

  const added = merged.filter((url) => !existing.includes(url));
  console.log(`Project: ${projectRef}`);
  console.log(`Existing entries: ${existing.length}`);
  console.log(`Merged entries: ${merged.length}`);
  console.log(`New entries (${added.length}):`);
  for (const url of added) console.log(`  + ${url}`);

  if (added.length === 0) {
    console.log("Nothing to update.");
    return;
  }

  if (dryRun) {
    console.log("Dry run — no changes written.");
    return;
  }

  const patchRes = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ uri_allow_list: merged.join(",") }),
  });
  if (!patchRes.ok) {
    console.error(`Failed to update auth config (${patchRes.status}):`, await patchRes.text());
    process.exit(1);
  }
  console.log("Updated Supabase auth redirect URLs.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
