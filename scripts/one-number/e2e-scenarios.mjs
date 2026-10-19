#!/usr/bin/env node
/**
 * One-number end-to-end scenarios against the REAL inbound webhook (src/app/api/twilio/inbound/route.ts) and the
 * DEV database (emstjswhotsnyksqhqyf). Nothing is sent: the dev server runs with a capture transport.
 *
 *   npm run seed:env                                   # once per worktree
 *   node scripts/one-number/e2e-scenarios.mjs          # all scenarios, own dev server on :3010
 *   node scripts/one-number/e2e-scenarios.mjs --only a,f --port 3010 --keep
 *   node scripts/one-number/e2e-scenarios.mjs --reap /path/to/ledger.json   # clean up a crashed run
 *
 * What it does: snapshots sms_runtime_config, flips it to `shared` with a pilot list holding only this run's
 * workspaces, creates throwaway fixtures (manager, workspace, house, resident, vendor...), starts
 * `next dev --webpack` with SMS_E2E_CAPTURE_FILE + a fake Twilio account, posts Twilio-signed form bodies, asserts the
 * reply text and the DB rows, then removes the fixtures and restores the config. Exit 1 when any check fails.
 */
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness, hex, loadDevEnv, createDb } from "./e2e/core.mjs";
import { cleanup } from "./e2e/cleanup.mjs";
import { World } from "./e2e/fixtures.mjs";
import { SCENARIOS } from "./e2e/scenarios.mjs";

function parse(argv) {
  const flags = { port: "3010", only: null, keep: false, reap: null, sweep: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--keep") flags.keep = true;
    else if (t === "--help") flags.help = true;
    else if (t === "--sweep") flags.sweep = true;
    else if (t === "--tick") flags.tick = true;
    else if (t === "--port") flags.port = argv[++i];
    else if (t === "--only") flags.only = argv[++i].split(",").map((s) => s.trim().toLowerCase());
    else if (t === "--reap") flags.reap = argv[++i];
    else throw new Error(`Unknown option ${t}`);
  }
  return flags;
}

async function restoreConfig(db, snapshot) {
  if (!snapshot) return;
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { error } = await db.from("sms_runtime_config").update(snapshot).eq("singleton", true);
    if (!error) return;
    lastError = error;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  console.error("!! could not restore sms_runtime_config:", lastError?.message, "snapshot:", JSON.stringify(snapshot));
}

async function main() {
  const flags = parse(process.argv.slice(2));
  if (flags.help) { console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]); return 0; }
  const { env, resolved } = loadDevEnv();
  console.log(`e2e: target=dev project=${resolved.ref}`);
  const db = createDb(resolved);

  if (flags.sweep) {
    // Every auth user this harness ever made carries the e2e-<run>-<label>@proplane-e2e.test address.
    const ids = [];
    for (let page = 1; page < 20; page += 1) {
      const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(`listUsers: ${error.message}`);
      for (const u of data.users) if (/^e2e-[0-9a-f]{6}-[a-z0-9-]+@proplane-e2e\.test$/.test(u.email ?? "")) ids.push(u.id);
      if (data.users.length < 200) break;
    }
    console.log(`e2e: sweeping ${ids.length} leftover harness user(s)`);
    const { data: ws } = ids.length ? await db.from("portal_workspaces").select("id").in("owner_user_id", ids) : { data: [] };
    const { data: houses } = ids.length ? await db.from("manager_property_records").select("id").in("manager_user_id", ids) : { data: [] };
    await cleanup(db, { userIds: ids, workspaceIds: (ws ?? []).map((w) => w.id), houseIds: (houses ?? []).map((h) => h.id), phones: [] }, console.log);
    return 0;
  }

  if (flags.reap) {
    const ledger = JSON.parse(readFileSync(flags.reap, "utf8"));
    await restoreConfig(db, ledger.configSnapshot);
    await cleanup(db, ledger.fixtures, console.log);
    return 0;
  }

  const runId = hex(6);
  const dir = mkdtempSync(join(tmpdir(), `one-number-e2e-${runId}-`));
  const ledgerFile = join(dir, "ledger.json");
  const captureFile = join(dir, "captured-sms.jsonl");
  const world = new World(db, runId);
  const h = new Harness({ env, resolved, port: Number(flags.port), captureFile });
  h.world = world;
  h.tick = Boolean(flags.tick);
  h.runId = runId;

  let cfg = null;
  let cfgError = null;
  for (let attempt = 0; attempt < 6 && !cfg; attempt += 1) {
    ({ data: cfg, error: cfgError } = await db.from("sms_runtime_config").select("line_mode, shared_number_e164, shared_messaging_service_sid, shared_pilot_workspace_ids, pilot_manager_user_ids").eq("singleton", true).maybeSingle());
    if (!cfg) await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
  }
  if (cfgError || !cfg) throw new Error(`cannot read sms_runtime_config: ${cfgError?.message ?? "no row"}`);
  // A shared line that is already live with a pilot list is another run's (or a crashed run's): never snapshot it as "normal".
  if (cfg.line_mode === "shared" && (cfg.shared_pilot_workspace_ids ?? []).length > 0) {
    throw new Error(`sms_runtime_config is already line_mode=shared with a pilot list (${JSON.stringify(cfg.shared_pilot_workspace_ids)}). A crashed run? Run --reap <its ledger.json>, or reset it by hand, then retry.`);
  }
  const configSnapshot = { ...cfg };
  h.sharedNumber = cfg.shared_number_e164;
  const writeLedger = () => writeFileSync(ledgerFile, JSON.stringify({ runId, configSnapshot, fixtures: { userIds: world.userIds, workspaceIds: world.workspaceIds, houseIds: world.houseIds, phones: world.phones } }, null, 2));
  writeLedger();
  console.log(`e2e: run ${runId}; ledger ${ledgerFile}; captured texts ${captureFile}`);

  const results = [];
  let exitCode = 0;
  const onSignal = async () => { h.stopServer(); await restoreConfig(db, configSnapshot); await cleanup(db, ledgerOf(), console.log); process.exit(130); };
  const ledgerOf = () => ({ userIds: world.userIds, workspaceIds: world.workspaceIds, houseIds: world.houseIds, phones: world.phones });
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const selected = SCENARIOS.filter((s) => !flags.only || flags.only.includes(s.id));
    for (const s of selected) await s.setup?.(h, world);
    writeLedger();
    // Shared line on for this run only, limited to this run's workspaces (a pilot list), and restored below.
    const pilot = world.workspaceIds;
    const { error } = await db.from("sms_runtime_config").update({ line_mode: "shared", shared_pilot_workspace_ids: pilot, pilot_manager_user_ids: [...new Set([...(configSnapshot.pilot_manager_user_ids ?? []), ...world.ownerIds])] }).eq("singleton", true);
    if (error) throw new Error(`cannot switch the line: ${error.message}`);
    console.log(`e2e: line_mode=shared pilot=[${pilot.length} workspaces] number=${h.sharedNumber}`);
    await h.startServer();
    console.log(`e2e: dev server ready on ${h.base}; full server log ${h.logFile}`);

    for (const s of selected) {
      const checks = [];
      const ctx = {
        h, world, db,
        check(name, ok, detail) { checks.push({ name, ok: Boolean(ok), detail: ok ? "" : String(detail ?? "") }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        ${String(detail ?? "").replace(/\n/g, "\n        ")}`}`); },
        note(text) { console.log(`        ${text.replace(/\n/g, "\n        ")}`); },
      };
      console.log(`\n== ${s.id.toUpperCase()}. ${s.title}`);
      try { await s.run(ctx); } catch (error) { ctx.check("scenario ran to the end", false, error instanceof Error ? error.stack ?? error.message : String(error)); }
      const failed = checks.filter((c) => !c.ok);
      results.push({ id: s.id, title: s.title, passed: checks.length - failed.length, failed: failed.length, failures: failed });
      if (failed.length) exitCode = 1;
    }
  } catch (error) {
    console.error("e2e: harness error:", error instanceof Error ? error.stack : error);
    console.error(h.logTail(30));
    exitCode = 2;
  } finally {
    h.stopServer();
    if (flags.keep) console.log("e2e: --keep: fixtures and shared line left in place; run --reap", ledgerFile);
    else {
      await restoreConfig(db, configSnapshot);
      await cleanup(db, ledgerOf(), console.log);
    }
  }

  console.log("\n== Summary");
  for (const r of results) console.log(`${r.failed ? "FAIL" : "PASS"}  ${r.id.toUpperCase()}  ${r.title}  (${r.passed} ok, ${r.failed} failed)`);
  return exitCode;
}

main().then((code) => { process.exitCode = code; }, (error) => { console.error("e2e: harness error: FAILED.", error instanceof Error ? error.message : error); process.exitCode = 2; });
