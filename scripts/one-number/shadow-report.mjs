#!/usr/bin/env node
/**
 * One-number migration step 6 (between shadow and shared): compare the router's shadow decisions with who
 * really owned each text. Read-only.
 *
 *   node --env-file=.env.local scripts/one-number/shadow-report.mjs --target dev [--since-hours 72] [--min-samples 50] [--min-agreement 0.98]
 *
 * In shadow mode (`line_mode = shadow`) every text on a normal work number is also routed, read-only, by the
 * shared-line router and the result is stored in sms_line_shadow_decisions next to the real owner
 * (`agrees` true / false / null when there was no owner to compare). Exit 1 when there are fewer than
 * --min-samples decided rows or the agreement rate is below --min-agreement: do not switch to shared yet.
 */
import { UsageError } from "./lib/args.mjs";
import { fetchAll } from "./lib/db.mjs";
import { bootstrap, isMain, runMain } from "./lib/runtime.mjs";

const SCRIPT = "shadow-report";

export async function run(argv, deps = {}) {
  const { flags, db, log } = bootstrap(SCRIPT, argv, { strings: ["since-hours", "min-samples", "min-agreement"] }, { write: false, deps });
  const sinceHours = Number(flags["since-hours"] ?? 72);
  const minSamples = Number(flags["min-samples"] ?? 50);
  const minAgreement = Number(flags["min-agreement"] ?? 0.98);
  for (const [n, label] of [[sinceHours, "since-hours"], [minSamples, "min-samples"]]) {
    if (!Number.isFinite(n) || n < 1) throw new UsageError(`--${label} must be a positive number.`);
  }
  if (!Number.isFinite(minAgreement) || minAgreement <= 0 || minAgreement > 1) throw new UsageError("--min-agreement must be between 0 and 1.");
  const since = new Date((deps.now ?? Date.now()) - sinceHours * 3600000).toISOString();
  const res = await fetchAll(db, "sms_line_shadow_decisions", "id, message_sid, decision, actual_owner_user_id, actual_workspace_id, agrees, created_at", {
    filter: (q) => q.gte("created_at", since),
  });
  if (res.missing) {
    log(`${SCRIPT}: sms_line_shadow_decisions does not exist here (run db:push). Nothing to compare.`);
    return 1;
  }
  const rows = res.rows;
  const decided = rows.filter((r) => r.agrees === true || r.agrees === false);
  const agree = decided.filter((r) => r.agrees === true).length;
  const disagree = decided.length - agree;
  const undecided = rows.length - decided.length;
  const rate = decided.length ? agree / decided.length : 0;
  const byKind = {};
  for (const r of decided.filter((d) => d.agrees === false)) {
    const kind = String(r.decision?.kind ?? "unknown");
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  log(`${SCRIPT}: last ${sinceHours}h: ${rows.length} shadow decisions, ${decided.length} comparable, ${agree} agree, ${disagree} disagree, ${undecided} with no real owner to compare`);
  log(`${SCRIPT}: agreement ${(rate * 100).toFixed(2)}% (need >= ${(minAgreement * 100).toFixed(2)}% over >= ${minSamples} comparable)`);
  for (const [kind, n] of Object.entries(byKind)) log(`${SCRIPT}:   disagreements where the router said "${kind}": ${n}`);
  for (const r of decided.filter((d) => d.agrees === false).slice(0, 10)) {
    log(`${SCRIPT}:   ${r.message_sid}: router=${JSON.stringify(r.decision?.kind)} workspace=${r.decision?.workspaceId ?? "-"} real workspace=${r.actual_workspace_id ?? "-"}`);
  }
  if (deps.report) deps.report.shadow = { total: rows.length, decided: decided.length, agree, disagree, rate };
  if (decided.length < minSamples) {
    log(`${SCRIPT}: NOT READY. Only ${decided.length} comparable decisions; keep shadow running.`);
    return 1;
  }
  if (rate < minAgreement) {
    log(`${SCRIPT}: NOT READY. Agreement is below the bar; read the disagreements before switching.`);
    return 1;
  }
  log(`${SCRIPT}: READY. The router agrees with the real owner often enough to switch to shared.`);
  return 0;
}

if (isMain(import.meta.url)) await runMain(SCRIPT, () => run(process.argv.slice(2)));
