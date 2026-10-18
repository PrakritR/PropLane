#!/usr/bin/env node
/**
 * One-number migration step 3: the spec's verification queries. Read-only. Exits 1 if any check fails.
 *
 *   node --env-file=.env.local scripts/one-number/verify.mjs --target dev --save-baseline /tmp/baseline.json   # BEFORE backfill
 *   node --env-file=.env.local scripts/one-number/verify.mjs --target dev --baseline /tmp/baseline.json       # AFTER
 *   ... --service-sid MG...    also check scoped opt-outs hold on the shared line's Messaging Service
 *   ... --strict-counts        counts must be EQUAL to the baseline (default: nothing lost, new live traffic allowed)
 *   ... --strict-orphans       rows that cannot be stamped (no owner / owner without a workspace) also fail
 *
 * Checks (spec "Production migration"):
 *   counts       conversation and turn counts did not fall; no baseline conversation or contact vanished
 *   stamps       zero rows without a workspace stamp, on all six stamped tables, wherever the owner has a workspace
 *   optouts      every phone opted out in the baseline is still opted out; every scoped revoke holds on the shared service
 *   aliases      every old conversation key still resolves (a conversation's legacy key or a legacy_key alias)
 *   isolation    no stamped row sits in a workspace its own owner does not hold (so no contact is visible to a team it had no thread with)
 *   contacts     every global contact with a user belongs to a verified profile with that very phone
 */
import { readFileSync } from "node:fs";
import { countRows, fetchAll } from "./lib/db.mjs";
import { writeJsonFile } from "./lib/files.mjs";
import { optedOutKeys } from "./lib/consent.mjs";
import { phoneKey } from "./lib/phones.mjs";
import { bootstrap, isMain, runMain } from "./lib/runtime.mjs";
import { STAMP_TABLES } from "./lib/stamp-plan.mjs";
import { planScopedOptOuts } from "./backfill.mjs";

const SCRIPT = "verify";

function check(name, failures, detail = "", warnings = []) {
  return { name, ok: failures.length === 0, failures, detail, warnings };
}

async function takeBaseline(db) {
  const [convs, contacts, turns, out] = await Promise.all([
    fetchAll(db, "sms_projection_conversations", "id"),
    fetchAll(db, "manager_sms_contacts", "id"),
    countRows(db, "sms_projection_turns"),
    optedOutKeys(db),
  ]);
  return {
    kind: "one-number-verify-baseline",
    takenAt: new Date().toISOString(),
    conversationIds: convs.rows.map((r) => r.id),
    contactIds: contacts.rows.map((r) => r.id),
    turnCount: turns.count,
    optedOutKeys: [...out].sort(),
    unresolvedKeys: (await unresolvedKeys(db)).unresolved,
  };
}

export async function run(argv, deps = {}) {
  const { flags, resolved, db, log } = bootstrap(
    SCRIPT,
    argv,
    { booleans: ["strict-counts", "strict-orphans"], strings: ["baseline", "save-baseline", "service-sid"] },
    { write: false, deps },
  );

  if (flags["save-baseline"]) {
    const baseline = { ...(await takeBaseline(db)), ref: resolved.ref };
    (deps.writeFile ?? writeJsonFile)(flags["save-baseline"], baseline);
    log(`${SCRIPT}: baseline saved to ${flags["save-baseline"]}: ${baseline.conversationIds.length} conversations, ${baseline.turnCount} turns, ${baseline.optedOutKeys.length} opted-out phones`);
    return 0;
  }

  const baseline = flags.baseline ? JSON.parse((deps.readFile ?? ((p) => readFileSync(p, "utf8")))(flags.baseline)) : null;
  if (baseline && baseline.ref !== resolved.ref) {
    log(`${SCRIPT}: REFUSED. The baseline is for project ${baseline.ref}, not ${resolved.ref}.`);
    return 2;
  }
  if (!baseline) log(`${SCRIPT}: no --baseline given: before/after comparisons are skipped (stamps, aliases, isolation and contacts still run).`);

  const results = [];
  results.push(await countsCheck(db, baseline, flags["strict-counts"]));
  results.push(...(await stampChecks(db, Boolean(flags["strict-orphans"]))));
  results.push(await optOutCheck(db, baseline, flags["service-sid"]));
  results.push(await aliasCheck(db, baseline));
  results.push(await isolationCheck(db));
  results.push(await contactsCheck(db));

  let failed = 0;
  for (const r of results) {
    log(`${SCRIPT}: ${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` - ${r.detail}` : ""}`);
    for (const f of r.failures.slice(0, 10)) log(`${SCRIPT}:     ${f}`);
    if (r.failures.length > 10) log(`${SCRIPT}:     ... and ${r.failures.length - 10} more`);
    for (const w of r.warnings) log(`${SCRIPT}:     note: ${w}`);
    if (!r.ok) failed += 1;
  }
  log(failed ? `${SCRIPT}: ${failed} check(s) FAILED` : `${SCRIPT}: all ${results.length} checks passed`);
  if (deps.report) deps.report.results = results;
  return failed ? 1 : 0;
}

async function countsCheck(db, baseline, strict) {
  const [convs, turns] = await Promise.all([fetchAll(db, "sms_projection_conversations", "id"), countRows(db, "sms_projection_turns")]);
  if (!baseline) return check("counts", [], `${convs.rows.length} conversations, ${turns.count} turns (no baseline)`);
  const failures = [];
  const have = new Set(convs.rows.map((r) => r.id));
  const lost = baseline.conversationIds.filter((id) => !have.has(id));
  if (lost.length) failures.push(`${lost.length} baseline conversations are gone`);
  if (turns.count < baseline.turnCount) failures.push(`turns fell from ${baseline.turnCount} to ${turns.count}`);
  if (strict) {
    if (convs.rows.length !== baseline.conversationIds.length) failures.push(`conversations ${baseline.conversationIds.length} -> ${convs.rows.length} (strict)`);
    if (turns.count !== baseline.turnCount) failures.push(`turns ${baseline.turnCount} -> ${turns.count} (strict)`);
  }
  const contacts = await fetchAll(db, "manager_sms_contacts", "id");
  const haveContacts = new Set(contacts.rows.map((r) => r.id));
  const lostContacts = (baseline.contactIds ?? []).filter((id) => !haveContacts.has(id));
  if (lostContacts.length) failures.push(`${lostContacts.length} baseline contacts are gone`);
  return check("counts", failures, `conversations ${baseline.conversationIds.length} -> ${convs.rows.length}, turns ${baseline.turnCount} -> ${turns.count}`);
}

async function ownerWorkspaceCounts(db) {
  const { rows } = await fetchAll(db, "portal_workspaces", "id, owner_user_id");
  const byOwner = new Map();
  for (const r of rows) byOwner.set(r.owner_user_id, (byOwner.get(r.owner_user_id) ?? 0) + 1);
  return { byOwner, ownerOf: new Map(rows.map((r) => [r.id, r.owner_user_id])) };
}

async function stampChecks(db, strictOrphans) {
  const { byOwner } = await ownerWorkspaceCounts(db);
  const out = [];
  for (const spec of STAMP_TABLES) {
    const res = await fetchAll(db, spec.table, `${spec.key}, ${spec.owner}`, { key: spec.key, filter: (q) => q.is("workspace_id", null) });
    if (res.missing) {
      out.push(check(`stamps:${spec.table}`, [`${spec.table}.workspace_id does not exist here (migration not run)`]));
      continue;
    }
    const stampable = res.rows.filter((r) => r[spec.owner] && (byOwner.get(r[spec.owner]) ?? 0) > 0);
    const orphans = res.rows.length - stampable.length;
    const failures = stampable.slice(0, 5).map((r) => `${spec.table} ${r[spec.key]} has no workspace stamp`);
    if (stampable.length > 5) failures.push(`... ${stampable.length} unstamped in total`);
    const warnings = [];
    if (orphans) {
      const text = `${orphans} row(s) cannot be stamped (no owner or the owner holds no workspace)`;
      if (strictOrphans) failures.push(text);
      else warnings.push(text);
    }
    out.push(check(`stamps:${spec.table}`, failures, `${stampable.length} unstamped`, warnings));
  }
  return out;
}

async function optOutCheck(db, baseline, flagSid) {
  const failures = [];
  const warnings = [];
  const now = await optedOutKeys(db);
  if (baseline) {
    const lost = baseline.optedOutKeys.filter((k) => !now.has(k));
    if (lost.length) failures.push(`${lost.length} phone(s) opted out before are no longer opted out`);
  } else {
    warnings.push("no baseline: cannot prove earlier opt-outs survived, only the scoped copy is checked");
  }
  let sid = flagSid ? String(flagSid).trim() : null;
  if (!sid) {
    const cfg = await fetchAll(db, "sms_runtime_config", "singleton, shared_messaging_service_sid", { key: "singleton" });
    sid = String(cfg.rows[0]?.shared_messaging_service_sid ?? "").trim() || null;
  }
  if (sid) {
    const events = await fetchAll(
      db,
      "sms_consent_events",
      "id, recipient_phone_key, manager_user_id, messaging_service_sid, purpose, send_class, conversation_key, event_type, wording_version, occurred_at, created_at",
    );
    if (!events.missing) {
      const plan = planScopedOptOuts({ events: events.rows, sharedSid: sid });
      if (plan.inserts.length) failures.push(`${plan.inserts.length} scoped opt-out(s) are not carried onto ${sid}`);
    }
  } else {
    warnings.push("scoped opt-out check skipped: no shared Messaging Service SID (pass --service-sid)");
  }
  return check("optouts", failures, `${now.size} phones opted out`, warnings);
}

/** Old conversation keys (from the message tables) that resolve to no conversation and no legacy_key alias. */
export async function unresolvedKeys(db) {
  const [messages, log, convs, aliases] = await Promise.all([
    fetchAll(db, "manager_sms_messages", "id, manager_user_id, conversation_key", { filter: (q) => q.not("conversation_key", "is", null) }),
    fetchAll(db, "inbound_sms_log", "id, manager_user_id, conversation_key", { filter: (q) => q.not("conversation_key", "is", null) }),
    fetchAll(db, "sms_projection_conversations", "id, owner_manager_user_id, legacy_conversation_key, conversation_key"),
    fetchAll(db, "sms_projection_aliases", "id, owner_manager_user_id, alias_kind, alias_value"),
  ]);
  const known = new Set();
  for (const c of convs.rows) {
    for (const k of [c.legacy_conversation_key, c.conversation_key]) if (k) known.add(`${c.owner_manager_user_id}|${k}`);
  }
  for (const a of aliases.rows) if (a.alias_kind === "legacy_key") known.add(`${a.owner_manager_user_id}|${a.alias_value}`);
  const seen = new Set();
  const unresolved = [];
  for (const row of [...messages.rows, ...log.rows]) {
    const key = String(row.conversation_key ?? "").trim();
    if (!key || key.startsWith("unresolved:") || !row.manager_user_id) continue;
    const tuple = `${row.manager_user_id}|${key}`;
    if (seen.has(tuple)) continue;
    seen.add(tuple);
    if (!known.has(tuple)) unresolved.push(tuple);
  }
  return { checked: seen.size, unresolved };
}

async function aliasCheck(db, baseline) {
  const { checked, unresolved } = await unresolvedKeys(db);
  const before = new Set(baseline?.unresolvedKeys ?? []);
  const fresh = unresolved.filter((t) => !before.has(t));
  const failures = fresh.map((t) => `conversation key "${t.split("|").slice(1).join("|")}" (owner ${t.split("|")[0]}) resolves to no conversation or alias`);
  const warnings = [];
  const carried = unresolved.length - fresh.length;
  if (carried) warnings.push(`${carried} key(s) already resolved to nothing before the migration (never projected into a conversation); not a regression`);
  return check("aliases", failures, `${checked} distinct old keys`, warnings);
}

async function isolationCheck(db) {
  const { ownerOf } = await ownerWorkspaceCounts(db);
  const failures = [];
  const specs = [...STAMP_TABLES.map((s) => ({ table: s.table, key: s.key, owner: s.owner })), { table: "sms_projection_conversations", key: "id", owner: "owner_manager_user_id" }];
  for (const spec of specs) {
    const res = await fetchAll(db, spec.table, `${spec.key}, ${spec.owner}, workspace_id`, { key: spec.key, filter: (q) => q.not("workspace_id", "is", null) });
    if (res.missing) continue;
    let bad = 0;
    for (const row of res.rows) {
      const holder = ownerOf.get(row.workspace_id);
      if (holder && holder !== row[spec.owner]) {
        bad += 1;
        if (bad <= 3) failures.push(`${spec.table} ${row[spec.key]} (owner ${row[spec.owner]}) is stamped into a workspace owned by ${holder}`);
      }
    }
    if (bad > 3) failures.push(`${spec.table}: ${bad} rows stamped across owners in total`);
  }
  return check("isolation", failures);
}

async function contactsCheck(db) {
  const contacts = await fetchAll(db, "sms_phone_contacts", "phone_e164, phone_key, user_id", { key: "phone_e164", filter: (q) => q.not("user_id", "is", null) });
  if (contacts.missing) return check("contacts", ["sms_phone_contacts is not migrated here"]);
  const failures = [];
  const claims = new Map();
  const profiles = await fetchAll(db, "profiles", "id, phone, phone_verified_at", { filter: (q) => q.not("phone", "is", null) });
  const byId = new Map(profiles.rows.map((p) => [p.id, p]));
  for (const p of profiles.rows) {
    const k = phoneKey(p.phone);
    if (!k) continue;
    claims.set(k, (claims.get(k) ?? 0) + 1);
  }
  for (const c of contacts.rows) {
    const p = byId.get(c.user_id);
    if (!p || phoneKey(p.phone) !== c.phone_key) failures.push(`contact ${c.phone_key} is tied to a user whose phone differs`);
    else if (!p.phone_verified_at) failures.push(`contact ${c.phone_key} is tied to a user with an unverified phone`);
    else if ((claims.get(c.phone_key) ?? 0) > 1) failures.push(`contact ${c.phone_key} is claimed by several accounts yet tied to one`);
  }
  return check("contacts", failures, `${contacts.rows.length} contacts with a user`);
}

if (isMain(import.meta.url)) await runMain(SCRIPT, () => run(process.argv.slice(2)));
