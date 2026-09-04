#!/usr/bin/env node
/**
 * Verify PropLane PostHog project settings match docs/observability.md.
 * Requires a personal API key (not the project token).
 *
 * Usage:
 *   POSTHOG_PERSONAL_API_KEY=phx_… npm run posthog:verify
 *
 * Get a key: https://us.posthog.com/project/492655/settings#personal-api-keys
 */

import { loadRepoEnv } from "./linear/load-env.mjs";

const PROJECT_ID = "492655";
const HOST = (process.env.POSTHOG_HOST ?? "https://us.posthog.com").replace(/\/$/, "");

const REQUIRED = {
  autocapture_opt_out: false,
  capture_dead_clicks: true,
  autcapture_web_vitals_opt_in: null, // key name varies; checked below
  session_recording_opt_in: true,
};

async function api(path) {
  loadRepoEnv();
  const key = process.env.POSTHOG_PERSONAL_API_KEY?.trim();
  if (!key) {
    throw new Error("POSTHOG_PERSONAL_API_KEY required — PostHog → Settings → Personal API keys");
  }
  const res = await fetch(`${HOST}/api${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

async function hogql(query) {
  loadRepoEnv();
  const key = process.env.POSTHOG_PERSONAL_API_KEY?.trim();
  const res = await fetch(`${HOST}/api/projects/${PROJECT_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });
  if (!res.ok) throw new Error(`HogQL → HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const project = await api(`/projects/${PROJECT_ID}/`);
  const sessionSettings = project.session_recording_opt_in;
  const autocapture = project.autocapture_opt_out;
  const deadClicks = project.capture_dead_clicks;
  const webVitals =
    project.autocapture_web_vitals_opt_in ?? project.autcapture_web_vitals_opt_in;

  const checks = [
    {
      name: "Autocapture enabled",
      ok: autocapture === false,
      detail: autocapture ? "autocapture_opt_out=true — clicks/pageviews inert" : "ok",
    },
    {
      name: "Dead / rage clicks",
      ok: deadClicks === true,
      detail: deadClicks ? "ok" : "capture_dead_clicks=false — frustration signals off",
    },
    {
      name: "Web vitals",
      ok: webVitals === true,
      detail: webVitals ? "ok" : "web vitals opt-in off — LCP/INP tiles empty",
    },
    {
      name: "Session replay",
      ok: sessionSettings === true,
      detail: sessionSettings ? "ok" : "session_recording_opt_in=false",
    },
    {
      name: "Browser proxy (/ingest)",
      ok: true,
      detail: "code uses api_host=/ingest — verify next.config.ts rewrites in deploy",
    },
  ];

  console.log(`PostHog project ${PROJECT_ID} (${project.name})\n`);
  let failed = 0;
  for (const c of checks) {
    const mark = c.ok ? "✓" : "✗";
    if (!c.ok) failed++;
    console.log(`${mark} ${c.name}: ${c.detail}`);
  }

  try {
    const identify = await hogql(`
      SELECT count() AS n
      FROM events
      WHERE event = '$identify'
        AND timestamp > now() - INTERVAL 30 DAY
    `);
    const identifyCount = identify?.results?.[0]?.[0] ?? "?";
    const pageviews = await hogql(`
      SELECT count(DISTINCT person_id) AS people
      FROM events
      WHERE event = '$pageview'
        AND timestamp > now() - INTERVAL 30 DAY
    `);
    const people = pageviews?.results?.[0]?.[0] ?? "?";
    console.log(`\nAnalytics (30d): ${people} people with pageviews, ${identifyCount} $identify events`);
    if (Number(identifyCount) < Number(people) / 10) {
      console.log(
        "⚠ $identify under-counts vs pageviews — session restore identify added in use-portal-session.ts",
      );
    }
  } catch (e) {
    console.log(`\n(warn: could not run HogQL — ${e.message})`);
  }

  console.log(
    "\nDashboard: https://us.posthog.com/project/492655/dashboard/1952875",
  );
  if (failed) {
    console.error(`\nposthog-verify: ${failed} setting(s) need fixing in PostHog UI`);
    process.exit(1);
  }
  console.log("\nposthog-verify: ok");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
