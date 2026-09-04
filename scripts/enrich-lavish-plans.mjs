#!/usr/bin/env node
/** Enrich Lavish plan HTML placeholders — one-off helper for fix-all batch */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLANS = join(ROOT, ".lavish", "plans");

const ENRICHMENTS = {
  "PRP-252-vendor-payments-show-real-manager-name": {
    scope: `<li><strong>In scope:</strong> Vendor Payments payee column shows the manager who owns the work order.</li><li><strong>Out of scope:</strong> Demo mode (may keep canonical demo name).</li>`,
    approach: `<li>Bug: <code>managerPayeeLabel()</code> in <code>vendor-payments-panel.tsx</code> always returns <code>CANONICAL_DEMO_MANAGER_NAME</code>.</li><li>Resolve name from <code>row.managerUserId</code> via cached profile map (fetch <code>/api/vendor/work-orders</code> enrichment or batch <code>profiles.full_name</code> on sync).</li><li>Reuse <code>managerDisplayName</code> pattern from <code>vendor-tasks.server.ts</code> on server; client cache keyed by manager id.</li><li>Fallback: "Property manager" when name missing.</li>`,
    risks: `<li>Extra fetch on mount if not embedded in work-order payload — prefer server-side denormalization on WO sync.</li>`,
    test: `<li>Vendor @test.proplane.local → Payments → payee is not "Test Manager" unless demo.</li><li>Unit: label helper with mock row + profile map.</li>`,
  },
  "PRP-253-resident-pay-when-manager-stripe-incomplete": {
    scope: `<li><strong>In scope:</strong> Resident sees clear state when Stripe Connect blocks checkout; no dead-end Pay button.</li><li><strong>Out of scope:</strong> Forcing manager onboarding.</li>`,
    approach: `<li><code>canPayHouseholdChargeWithAxisAch</code> reads listing snapshot only — not manager Connect status.</li><li>Add server truth: manager <code>stripe_connect_account_id</code> + <code>connectAccountTransfersActive</code> on charge list API or eligibility helper.</li><li>UI: when ACH eligible on listing but Connect inactive, show inline notice + disable Pay (manual channels still work if configured).</li><li>Checkout route should return friendly error if Connect incomplete (belt-and-suspenders).</li>`,
    risks: `<li>Must not leak other managers' Stripe state — scope by landlord id on charge.</li>`,
    test: `<li>Resident with pending charge + manager without Connect → no silent checkout failure.</li><li>With Connect complete → Pay opens Stripe checkout.</li>`,
  },
  "PRP-305-public-browse-redirect": {
    scope: `<li><strong>In scope:</strong> <code>/browse</code> and <code>/browse/:path*</code> redirect to <code>/rent/browse</code>.</li><li><strong>Out of scope:</strong> Marketing site IA redesign.</li>`,
    approach: `<li>Add permanent redirect in <code>next.config.ts</code> <code>redirects()</code>: <code>{ source: '/browse', destination: '/rent/browse', permanent: false }</code> plus catch-all for subpaths.</li><li>Add unit test mirroring other legacy redirect tests if present.</li>`,
    risks: `<li>None — housing browse lives at <code>src/app/(public)/rent/browse/page.tsx</code>.</li>`,
    test: `<li><code>curl -I http://localhost:3010/browse</code> → 307/308 to /rent/browse</li>`,
  },
  "PRP-233-vendor-payout-retry-after-stripe-connect": {
    scope: `<li><strong>In scope:</strong> Failed <code>vendor_payouts</code> rows retry when vendor completes Stripe Connect.</li><li><strong>Out of scope:</strong> Manager-side manual re-approve.</li>`,
    approach: `<li>On vendor Connect status success (<code>/api/vendor/stripe-connect/status</code> or onboard return), call <code>retryFailedVendorPayouts(vendorUserId)</code>.</li><li>Retry: select <code>vendor_payouts</code> where <code>status='failed'</code> and failure reason is connect-related; re-invoke transfer path with existing idempotency key.</li><li>Do not duplicate paid rows — unique on <code>work_order_id</code> already guards inserts.</li>`,
    risks: `<li>Stripe idempotency — reuse <code>vendor-payout:\${workOrderId}</code> key on retry.</li>`,
    test: `<li>Unit: failed row + mock connected account → status becomes paid or new failure reason.</li><li>Manual: vendor connects after failed payout → payout retries.</li>`,
  },
  "PRP-298-session-lost-on-documents-routes": {
    scope: `<li><strong>In scope:</strong> Documents templates/other tabs stop bouncing to sign-in during normal use and QA bursts.</li><li><strong>Out of scope:</strong> True session expiry UX (expected logout).</li>`,
    approach: `<li>Reproduce: rapid tab sweep in <code>qa-exhaustive-portal-audit.mjs</code> vs single manual visit.</li><li>Check middleware + <code>getPortalAccessContext</code> on documents API routes; 429 rate limits masquerading as auth loss.</li><li>QA: add delay between routes or reuse single session cookie jar; fix product only if manual path also fails.</li><li>If fetch fires before auth cookie set: gate client fetches on <code>authReady</code> in documents panels.</li>`,
    risks: `<li>May be partially QA artifact — verify manual before large refactor.</li>`,
    test: `<li>Manual: manager → Documents → Templates, stay 30s, refresh — still authed.</li><li>Exhaustive re-run: zero PRP-298 findings.</li>`,
  },
  "PRP-250-portal-console-401-noise": {
    scope: `<li><strong>In scope:</strong> Reduce console 401 errors on portal tabs during navigation (manager + resident).</li><li><strong>Out of scope:</strong> Hiding legitimate unauthorized responses.</li>`,
    approach: `<li>Cluster: parallel fetches on mount before session resolved; coalesce with auth-ready guard pattern used elsewhere.</li><li>Audit top offenders from QA manifest (dashboard, leases, finances, documents).</li><li>Prefer <code>credentials: 'include'</code> + skip fetch until <code>useManagerUserId().ready</code>.</li><li>Consider shared <code>useAuthedFetch</code> that queues until session exists.</li>`,
    risks: `<li>Large surface — fix highest-traffic panels first; accept some low-traffic 401 if session truly missing.</li>`,
    test: `<li>Playwright exhaustive: console listener count drops for manager dashboard + resident payments.</li>`,
  },
};

for (const [dir, e] of Object.entries(ENRICHMENTS)) {
  const htmlPath = join(PLANS, dir, "plan.html");
  let html = readFileSync(htmlPath, "utf8");
  html = html.replace(
    /<li><strong>In scope:<\/strong> _…_<\/li>\s*<li><strong>Out of scope:<\/strong> _…_<\/li>/,
    e.scope,
  );
  html = html.replace(
    /<ol class="list-decimal pl-5 space-y-2">[\s\S]*?<\/ol>/,
    `<ol class="list-decimal pl-5 space-y-2">${e.approach}</ol>`,
  );
  html = html.replace(
    /<section class="card bg-base-100 shadow-md mb-6">\s*<div class="card-body">\s*<h2 class="card-title text-lg">Risks[\s\S]*?<\/section>/,
    `<section class="card bg-base-100 shadow-md mb-6"><div class="card-body"><h2 class="card-title text-lg">Risks &amp; open questions</h2><ul class="list-disc pl-5">${e.risks}</ul></div></section>`,
  );
  html = html.replace(
    /<li>Happy path on <code>localhost:3011<\/code>[\s\S]*?<li><code>npm run test:unit<\/code> — targeted specs<\/li>/,
    e.test,
  );
  writeFileSync(htmlPath, html);
  console.log("enriched", dir);
}
