#!/usr/bin/env node
/**
 * One-number migration step 5: flip the line mode (and tell people where we moved).
 *
 *   node --env-file=.env.local scripts/one-number/cutover.mjs --target dev --mode shadow  --shared-number +12065550100 --service-sid MGxxxxxxxx...
 *   node --env-file=.env.local scripts/one-number/cutover.mjs --target dev --mode shared  --shared-number +12065550100 --service-sid MGxxxxxxxx... --apply
 *   ... --notify-moved [--since-days 365] [--per-minute 30]   queue the one "We've moved" text per contact (shared only)
 *   ... --rollback --apply                                     line_mode back to per_workspace, cancels unsent notices
 *   ... --pilot <workspace-id>,<workspace-id>                  only these workspaces move (empty = everyone)
 *
 * Dry run by default. It sets exactly four columns on the sms_runtime_config singleton: line_mode,
 * shared_number_e164, shared_messaging_service_sid, shared_pilot_workspace_ids. Before it writes, it
 * validates the number as E.164 and, in READ-ONLY mode, asks Twilio whether that number is attached to the
 * Messaging Service (GET .../Services/{sid}/PhoneNumbers). It never sends, buys, attaches or releases anything.
 *
 * Who ends on the shared line (decisions #4-#6): every workspace without a paid personalized number. The
 * list printed here mirrors the app's own rule for information only; the app decides live (it reads the
 * entitlement at routing time), so this output cannot move anyone.
 *
 * --notify-moved queues one row per phone in sms_moved_notices. The text is a PLATFORM send: PropLane pays for
 * it (no workspace wallet, no credit hold) and it leaves from the SHARED number (the platform_lead path of
 * sendSms), sent by the /api/cron/moved-notices dispatcher, which applies consent, quiet hours and the
 * real-customer shield. A phone that was already told (a queued or sent row, an auto-reply in the last 30
 * days) is not queued again. Opted-out phones are never queued.
 */
import { UsageError } from "./lib/args.mjs";
import { optedOutKeys, scopedRevokedKeys } from "./lib/consent.mjs";
import { chunk, fetchAll } from "./lib/db.mjs";
import { nextPacificDaytime } from "./lib/pacific.mjs";
import { formatDisplay, normalizeE164, phoneKey } from "./lib/phones.mjs";
import { bootstrap, isMain, runMain } from "./lib/runtime.mjs";
import { GuardError } from "./lib/target.mjs";

const SCRIPT = "cutover";
const MODES = ["shadow", "shared"];
const SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const NOTICE_TABLE = "sms_moved_notices";
export const NOTICE_SOURCE = "cutover";
const PAID_STATUSES = new Set(["active", "past_due"]);

export function movedNoticeText(sharedNumber) {
  return `We've moved to ${formatDisplay(sharedNumber)}. Save this number.`;
}

/** Read-only Twilio check: is `number` attached to Messaging Service `sid`? Throws a GuardError when it is not provable. */
export async function assertNumberOnService({ number, sid, env, fetchImpl = globalThis.fetch }) {
  const account = String(env.TWILIO_ACCOUNT_SID ?? "").trim();
  const keySid = String(env.TWILIO_API_KEY_SID ?? "").trim();
  const keySecret = String(env.TWILIO_API_KEY_SECRET ?? "").trim();
  const token = String(env.TWILIO_AUTH_TOKEN ?? "").trim();
  const user = keySid && keySecret ? keySid : account;
  const pass = keySid && keySecret ? keySecret : token;
  if (!account || !user || !pass) throw new GuardError("Twilio credentials are missing (TWILIO_ACCOUNT_SID plus an auth token or API key); cannot verify the number is on the service.");
  const auth = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  let url = `https://messaging.twilio.com/v1/Services/${sid}/PhoneNumbers?PageSize=100`;
  for (let page = 0; page < 20 && url; page += 1) {
    const res = await fetchImpl(url, { method: "GET", headers: { Authorization: auth, Accept: "application/json" } });
    if (!res.ok) throw new GuardError(`Twilio refused the read-only check (HTTP ${res.status}) for service ${sid}.`);
    const body = await res.json();
    if ((body.phone_numbers ?? []).some((p) => normalizeE164(p.phone_number) === number)) return true;
    const next = body.meta?.next_page_url;
    url = next ? String(next) : null;
  }
  throw new GuardError(`${number} is not attached to Messaging Service ${sid}. Attach it in Twilio first (a human step), then run again.`);
}

/** Workspaces by where they end up. Pure. */
export function classifyWorkspaces({ workspaces, numbers, entitlements, pilot }) {
  const paidOwners = new Set(
    entitlements.filter((e) => ["pro", "business"].includes(String(e.tier)) && PAID_STATUSES.has(String(e.status))).map((e) => e.manager_user_id),
  );
  const liveByWorkspace = new Map();
  for (const n of numbers) {
    if (n.released_at || !n.phone_number || n.provision_state !== "active" || !n.workspace_id) continue;
    const list = liveByWorkspace.get(n.workspace_id) ?? [];
    list.push(n);
    liveByWorkspace.set(n.workspace_id, list);
  }
  const shared = [];
  const keepsOwn = [];
  const outsidePilot = [];
  for (const ws of workspaces) {
    const live = liveByWorkspace.get(ws.id) ?? [];
    if (pilot.length && !pilot.includes(ws.id)) {
      outsidePilot.push(ws);
      continue;
    }
    if (live.length && paidOwners.has(ws.owner_user_id)) keepsOwn.push({ ws, numbers: live, via: "paid plan" });
    else shared.push({ ws, oldNumbers: live });
  }
  return { shared, keepsOwn, outsidePilot };
}

export async function run(argv, deps = {}) {
  const { flags, resolved, db, log } = bootstrap(
    SCRIPT,
    argv,
    {
      booleans: ["rollback", "notify-moved", "skip-twilio-check"],
      strings: ["mode", "shared-number", "service-sid", "pilot", "since-days", "per-minute"],
    },
    { write: (f) => Boolean(f.apply), deps },
  );
  const apply = Boolean(flags.apply);
  const report = deps.report ?? {};
  const env = deps.env ?? process.env;

  const current = await readConfig(db);
  log(`${SCRIPT}: current line_mode=${current.line_mode} shared_number=${current.shared_number_e164 ?? "none"} service=${current.shared_messaging_service_sid ?? "none"} pilot=${(current.shared_pilot_workspace_ids ?? []).length || "everyone"}`);
  report.before = current;

  if (flags.rollback) {
    if (flags.mode || flags["notify-moved"]) throw new UsageError("--rollback stands alone (no --mode, no --notify-moved).");
    log(`${SCRIPT}: ROLLBACK plan: line_mode ${current.line_mode} -> per_workspace (number and service stay recorded); unsent move notices are canceled`);
    const queued = await fetchAll(db, NOTICE_TABLE, "phone_key, status", { key: "phone_key", filter: (q) => q.eq("source", NOTICE_SOURCE).eq("status", "queued") });
    log(`${SCRIPT}: ${queued.rows.length} unsent move notice(s) would be canceled`);
    report.rollback = { cancel: queued.rows.length };
    if (!apply) return dry(log);
    await writeConfig(db, { line_mode: "per_workspace" });
    // An unsent notice is removed, so a later cutover can queue the phone again; a sent one stays as the record.
    for (const batch of chunk(queued.rows.map((r) => r.phone_key), 200)) {
      const { error } = await db.from(NOTICE_TABLE).delete().in("phone_key", batch).eq("status", "queued").eq("source", NOTICE_SOURCE);
      if (error) throw new Error(`${NOTICE_TABLE}: ${error.message}`);
    }
    log(`${SCRIPT}: rolled back. Texts to the shared number are no longer routed; every workspace is on its own number again.`);
    return 0;
  }

  const mode = flags.mode;
  if (!MODES.includes(mode)) throw new UsageError("--mode shadow|shared is required (or --rollback).");
  const number = normalizeE164(flags["shared-number"] ?? current.shared_number_e164);
  const sid = String(flags["service-sid"] ?? current.shared_messaging_service_sid ?? "").trim();
  if (flags["shared-number"] && !number) throw new UsageError(`"${flags["shared-number"]}" is not a valid phone number.`);
  if (mode === "shared" && !number) throw new UsageError("--shared-number +1XXXXXXXXXX (E.164) is required for shared mode.");
  if (mode === "shared" && !SERVICE_SID.test(sid)) throw new UsageError("--service-sid MG... (the shared Messaging Service) is required for shared mode.");
  if (sid && !SERVICE_SID.test(sid)) throw new UsageError(`"${sid}" is not a Messaging Service SID.`);
  const pilot = flags.pilot ? flags.pilot.split(",").map((s) => s.trim()).filter(Boolean) : (current.shared_pilot_workspace_ids ?? []);
  for (const id of pilot) if (!UUID.test(id)) throw new UsageError(`--pilot: "${id}" is not a workspace id.`);
  if (flags["notify-moved"] && mode !== "shared") throw new UsageError("--notify-moved only makes sense with --mode shared (people would be told to text a number that is not answering).");

  // Read-only Twilio check: skipped only on dev, only when asked.
  if (number && sid) {
    if (flags["skip-twilio-check"]) {
      if (resolved.target !== "dev") throw new GuardError("--skip-twilio-check is only allowed on --target dev.");
      log(`${SCRIPT}: Twilio check SKIPPED (dev)`);
    } else {
      await assertNumberOnService({ number, sid, env, fetchImpl: deps.fetch });
      log(`${SCRIPT}: Twilio (read-only): ${number} is attached to ${sid}`);
    }
  } else if (mode === "shadow") {
    log(`${SCRIPT}: shadow mode without a number/service: routing is only compared, nothing is sent from a shared line`);
  }

  const classes = await classify(db, pilot);
  report.classes = { shared: classes.shared.length, keepsOwn: classes.keepsOwn.length, outsidePilot: classes.outsidePilot.length };
  log(`${SCRIPT}: ${mode === "shared" ? "AFTER the switch" : "when shared goes live"}: ${classes.shared.length} workspace(s) text on the shared line, ${classes.keepsOwn.length} keep a paid personalized number${classes.outsidePilot.length ? `, ${classes.outsidePilot.length} are outside the pilot` : ""}`);
  for (const k of classes.keepsOwn.slice(0, 20)) log(`${SCRIPT}:   keeps own: ${k.ws.name ?? k.ws.id} (${k.numbers.map((n) => n.phone_number).join(", ")}) via ${k.via}`);
  const retiring = classes.shared.reduce((n, s) => n + s.oldNumbers.length, 0);
  log(`${SCRIPT}: ${retiring} old work number(s) belong to workspaces that move; they keep answering and are retired after 60 days by the runbook`);

  const config = { line_mode: mode, shared_number_e164: number ?? null, shared_messaging_service_sid: sid || null, shared_pilot_workspace_ids: pilot };
  log(`${SCRIPT}: ${apply ? "setting" : "would set"} ${JSON.stringify(config)}`);
  if (apply) {
    await writeConfig(db, config);
    log(`${SCRIPT}: line_mode is now ${mode}. Roll back with: --rollback --apply`);
  }

  if (flags["notify-moved"]) {
    await notifyMoved(db, {
      apply,
      log,
      report,
      classes,
      sharedNumber: number,
      sinceDays: flags["since-days"] ? Number(flags["since-days"]) : null,
      perMinute: flags["per-minute"] ? Number(flags["per-minute"]) : 30,
      now: new Date(deps.now ?? Date.now()),
    });
  }
  if (!apply) dry(log);
  return 0;
}

function dry(log) {
  log(`${SCRIPT}: dry run, nothing written. Re-run with --apply to write.`);
  return 0;
}

async function readConfig(db) {
  const res = await db.from("sms_runtime_config").select("singleton, line_mode, shared_number_e164, shared_messaging_service_sid, shared_pilot_workspace_ids").eq("singleton", true).maybeSingle();
  if (res.error) throw new Error(`sms_runtime_config: ${res.error.message} (is migration 20261018090000_one_number_shared_line.sql applied?)`);
  if (!res.data) throw new Error("sms_runtime_config has no row; the SMS control-plane migration seeds it.");
  return res.data;
}

async function writeConfig(db, patch) {
  const { error, data } = await db.from("sms_runtime_config").update({ ...patch, updated_at: new Date().toISOString() }).eq("singleton", true).select("singleton");
  if (error) throw new Error(`sms_runtime_config: ${error.message}`);
  if (!data?.length) throw new Error("sms_runtime_config row was not updated");
}

async function classify(db, pilot) {
  const [workspaces, numbers, entitlements] = await Promise.all([
    fetchAll(db, "portal_workspaces", "id, owner_user_id, name"),
    fetchAll(db, "manager_sms_numbers", "id, manager_user_id, workspace_id, phone_number, provision_state, released_at"),
    fetchAll(db, "sms_manager_entitlements", "manager_user_id, tier, status", { key: "manager_user_id" }),
  ]);
  return classifyWorkspaces({ workspaces: workspaces.rows, numbers: numbers.rows, entitlements: entitlements.rows, pilot });
}

async function notifyMoved(db, { apply, log, report, classes, sharedNumber, sinceDays, perMinute, now }) {
  if (!Number.isFinite(perMinute) || perMinute < 1 || perMinute > 600) throw new UsageError("--per-minute must be 1-600.");
  const text = movedNoticeText(sharedNumber);
  const [optedOut, revoked] = await Promise.all([optedOutKeys(db), scopedRevokedKeys(db)]);
  const cutoff = sinceDays ? now.getTime() - sinceDays * 86400000 : null;
  const rows = [];
  const perWorkspace = [];
  let skippedOptOut = 0;
  let skippedNoPhone = 0;
  let skippedStale = 0;
  const seen = new Set();
  let slot = 0;
  for (const { ws, oldNumbers } of classes.shared) {
    let count = 0;
    for (const number of oldNumbers) {
      const convs = await fetchAll(
        db,
        "sms_projection_conversations",
        "id, owner_manager_user_id, counterparty_role, counterparty_phone, conversation_key, legacy_conversation_key, last_event_at, merged_into_id, line_kind",
        { filter: (q) => q.eq("work_line_id", number.id) },
      );
      for (const c of convs.rows) {
        if (c.merged_into_id || c.line_kind === "shared") continue;
        if (!["resident", "applicant", "prospect", "vendor"].includes(c.counterparty_role)) continue;
        const e164 = normalizeE164(c.counterparty_phone);
        if (!e164) {
          skippedNoPhone += 1;
          continue;
        }
        const key = phoneKey(e164);
        if (optedOut.has(key) || revoked.has(`${c.owner_manager_user_id}|${key}`)) {
          skippedOptOut += 1;
          continue;
        }
        if (cutoff && Date.parse(c.last_event_at ?? 0) < cutoff) {
          skippedStale += 1;
          continue;
        }
        // One notice per PHONE: the shared number is the same whichever workspace the contact belongs to.
        if (seen.has(key)) continue;
        seen.add(key);
        const when = nextPacificDaytime(new Date(now.getTime() + Math.floor((slot * 60000) / perMinute)));
        slot += 1;
        rows.push({ phone_key: key, workspace_id: ws.id, source: NOTICE_SOURCE, status: "queued", available_at: when.toISOString() });
        count += 1;
      }
    }
    perWorkspace.push({ workspace: ws.name ?? ws.id, recipients: count });
  }
  report.notify = { recipients: rows.length, skippedOptOut, skippedNoPhone, skippedStale, perWorkspace };
  log(`${SCRIPT}: notify-moved: "${text}"`);
  for (const w of perWorkspace.filter((w) => w.recipients).slice(0, 30)) log(`${SCRIPT}:   ${w.workspace}: ${w.recipients}`);
  log(`${SCRIPT}: notify-moved: ${rows.length} to queue, skipped ${skippedOptOut} opted out, ${skippedNoPhone} without a usable phone, ${skippedStale} idle past --since-days`);
  if (!apply || rows.length === 0) return;
  let queued = 0;
  for (const batch of chunk(rows, 200)) {
    // A phone that already has a row (queued, or told by an auto-reply in the window) is left alone.
    const { data, error } = await db.from(NOTICE_TABLE).upsert(batch, { onConflict: "phone_key", ignoreDuplicates: true }).select("phone_key");
    if (error) throw new Error(`${NOTICE_TABLE}: ${error.message}`);
    queued += (data ?? []).length;
  }
  report.notify.queued = queued;
  log(`${SCRIPT}: notify-moved: queued ${queued} (${rows.length - queued} were already queued or told). The platform dispatcher (/api/cron/moved-notices) sends them from the shared number within daytime hours; cancel with --rollback.`);
}

if (isMain(import.meta.url)) await runMain(SCRIPT, () => run(process.argv.slice(2)));
