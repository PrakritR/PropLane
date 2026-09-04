#!/usr/bin/env node
/** One-shot enrich Lavish plan HTML for QA sweep tickets. */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLANS = join(ROOT, ".lavish", "plans");

const ENRICHMENTS = {
  "PRP-223": {
    scope: {
      in: "Whitelist <code>/auth/connect-google-services</code> in <code>isValidPostAuthDestination()</code> (<code>src/lib/auth/resolve-post-auth-destination.ts</code>). Add unit regression in <code>tests/unit/resolve-post-auth-destination.test.ts</code>.",
      out: "Google OAuth connect flow itself; changing API redirect semantics.",
    },
    approach: [
      "Add <code>/auth/connect-google-services</code> to the allowlist next to other <code>/auth/*</code> onboarding paths.",
      "Verify <code>/auth/continue</code> stops retrying when API returns that destination (~2s dwell, not ~55s).",
      "Unit test: valid destination accepts connect-google-services; invalid paths still rejected.",
    ],
    risks: ["Must not allow open redirects — path is fixed, not query-param driven."],
    tests: [
      "Sign in as <code>manager@test.proplane.local</code> on :3011 — lands on dashboard or connect-google-services without long spinner.",
      "<code>npm run test:unit -- resolve-post-auth-destination</code>",
    ],
    status: "Fix drafted in working tree — approve to commit.",
  },
  "PRP-224": {
    scope: {
      in: "<code>PortalCalendarPanels</code> compact availability mode (<code>src/components/portal/portal-calendar-panels.tsx</code>) — keep week navigation when no localStorage key.",
      out: "Full calendar data seeding; tour booking logic.",
    },
    approach: [
      "Skip the early-return empty state when <code>compactAvailability</code> is true so Previous/Next week buttons still render.",
      "Confirm e2e <code>manager-portal.spec.ts</code> calendar case passes on :3011.",
    ],
    risks: ["Empty state copy may still show above nav — acceptable if nav is the regression target."],
    tests: [
      "Mobile width at <code>/portal/calendar/tours</code> — Previous week visible.",
      "<code>E2E_TESTS_ENABLED=1 npx playwright test tests/e2e/manager-portal.spec.ts -g calendar</code>",
    ],
    status: "Fix drafted in working tree — approve to commit.",
  },
  "PRP-296": {
    scope: {
      in: "Permanent redirect <code>/browse</code> → <code>/rent/browse</code> in <code>next.config.ts</code>. Unit test in <code>tests/unit/browse-redirect.test.ts</code>.",
      out: "Browse card UI; listing catalog content.",
    },
    approach: [
      "Add redirect entry (307) ahead of conflicting routes.",
      "Assert redirect config in unit test.",
    ],
    risks: ["None — legacy marketing links only."],
    tests: ["<code>curl -I http://localhost:3011/browse</code> → 307 to /rent/browse"],
    status: "Fix drafted in working tree — approve to commit.",
  },
  "PRP-225": {
    scope: {
      in: "Properties list ADD row at plan cap (<code>pro-properties.tsx</code>, <code>pro-house-properties-panel.tsx</code>, <code>portal-list-add-row.tsx</code>).",
      out: "Changing plan entitlements or Stripe SKUs.",
    },
    approach: [
      "Pass <code>addPropertyDisabled={!skuLoaded || atPropertyLimit}</code> from <code>pro-properties.tsx</code> (today only gates on <code>!skuLoaded</code>).",
      "When disabled at limit, show visible inline hint on the dashed row (plan limit + View plans link) — not toast-only.",
      "Keep <code>tryOpenAdd</code> toast as backup for keyboard/accessibility paths.",
    ],
    risks: ["Native app may omit upgrade link — respect <code>isNativeRuntimeSync()</code> CTA rules."],
    tests: [
      "Seed manager at property cap on :3011 — ADD row looks disabled, click shows upgrade path.",
      "Below cap — wizard opens normally.",
    ],
  },
  "PRP-226": {
    scope: {
      in: "Gate Communication background fetches on resolved session + SMS capability (<code>pro-communication.tsx</code>, <code>pro-unified-inbox.tsx</code>, settings panels hitting <code>/api/portal/automation-settings</code>).",
      out: "Twilio provisioning; changing API auth model.",
    },
    approach: [
      "Do not call <code>/api/manager/sms-conversations</code> or <code>/api/manager/messaging-number</code> until <code>useManagerUserId()</code> resolves and <code>smsOutboundEnabled</code> is true.",
      "Automation settings poll only when Communication settings surface is mounted / module visible.",
      "Treat 401 as signed-out: skip retry loops (no console error spam in audit).",
    ],
    risks: ["Free-tier managers without SMS — must not poll SMS routes at all."],
    tests: [
      "Open Communication on :3011 — Network tab shows no repeating 401s.",
      "<code>node scripts/qa-portal-audit-v3.mjs</code> communication path clean.",
    ],
  },
  "PRP-300": {
    scope: {
      in: "Residents list surface — add dashed <code>PortalListAddRow</code> footer matching Properties pattern (<code>pro-residents.tsx</code>).",
      out: "New invite flows; co-manager permissions model.",
    },
    approach: [
      "Wire existing <code>setAddResidentOpen(true)</code> to ADD row with <code>PORTAL_LIST_ADD_ICONS.resident</code> and <code>ariaLabel=\"Add resident\"</code>.",
      "Show inline on list view; hide on detail drill-down (same as other tabs).",
    ],
    risks: ["Empty portfolio — row should still open add modal with property picker guard."],
    tests: ["Residents tab list — ADD footer visible; opens add-resident modal."],
  },
  "PRP-298": {
    scope: {
      in: "Legacy URL <code>/portal/financials/cash-flow-statement</code> → active finances tab (<code>render-portal-section.tsx</code> / <code>next.config.ts</code>).",
      out: "Cash flow report calculations.",
    },
    approach: [
      "Add manager financials legacy redirect (same pattern as other finance tab aliases).",
      "Ensure authenticated managers land on cash-flow tab, not sign-in.",
    ],
    risks: ["Conflicts with existing financials redirect table — grep before adding."],
    tests: ["Logged-in manager navigates to cash-flow-statement URL — stays in portal on correct tab."],
  },
  "PRP-234": {
    scope: {
      in: "Residents tab Supabase/browser fetch failures — trace loader in <code>pro-residents.tsx</code> and related hooks; fail gracefully when session not ready.",
      out: "RLS policy changes.",
    },
    approach: [
      "Identify fetch fired before auth/session (console TypeError: Failed to fetch).",
      "Gate client sync on <code>scopeUserId</code> / session resolved; coalesce refresh per existing TTL pattern.",
      "Add error boundary toast instead of silent console error.",
    ],
    risks: ["May be dev/test Supabase egress or CORS — verify on :3011 with seeded data."],
    tests: ["Residents tab — zero console errors after load."],
  },
};

function enrichPlan(dir, ticket) {
  const htmlPath = join(dir, "plan.html");
  let html = readFileSync(htmlPath, "utf8");
  const e = ENRICHMENTS[ticket];
  if (!e) return false;

  html = html.replace(
    /<li><strong>In scope:<\/strong> _…_<\/li>\s*<li><strong>Out of scope:<\/strong> _…_<\/li>/,
    `<li><strong>In scope:</strong> ${e.scope.in}</li>\n          <li><strong>Out of scope:</strong> ${e.scope.out}</li>`,
  );

  const steps = e.approach.map((s, i) => `<li>${s}</li>`).join("\n          ");
  html = html.replace(
    /<ol class="list-decimal pl-5 space-y-2">[\s\S]*?<\/ol>/,
    `<ol class="list-decimal pl-5 space-y-2">\n          ${steps}\n        </ol>`,
  );

  const risks = e.risks.map((r) => `<li>${r}</li>`).join("\n          ");
  html = html.replace(
    /<ul class="list-disc pl-5">\s*<li>_…_<\/li>\s*<\/ul>/,
    `<ul class="list-disc pl-5">\n          ${risks}\n        </ul>`,
  );

  const tests = e.tests
    .map((t) => `<li>${t}</li>`)
    .concat(["<li><code>npm run test:unit</code> — no regressions</li>"])
    .join("\n          ");
  html = html.replace(
    /<ul class="list-disc pl-5">\s*<li>Happy path[\s\S]*?<\/ul>/,
    `<ul class="list-disc pl-5">\n          ${tests}\n        </ul>`,
  );

  if (e.status) {
    html = html.replace(
      '<div class="alert alert-info mt-8">',
      `<div class="alert alert-success mb-4"><span>${e.status}</span></div>\n    <div class="alert alert-info mt-8">`,
    );
  }

  writeFileSync(htmlPath, html);
  return true;
}

let n = 0;
for (const name of readdirSync(PLANS)) {
  const dir = join(PLANS, name);
  if (!statSync(dir).isDirectory()) continue;
  const m = name.match(/^(PRP-\d+)/);
  if (!m) continue;
  if (enrichPlan(dir, m[1])) {
    n++;
    console.log("enriched", m[1], join(dir, "plan.html"));
  }
}
console.log(`Done: ${n} plans enriched`);
