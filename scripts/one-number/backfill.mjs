#!/usr/bin/env node
/**
 * One-number migration step 2: the idempotent backfill. Dry run by default.
 *
 *   node --env-file=.env.local scripts/one-number/backfill.mjs --target dev            # plan only
 *   node --env-file=.env.local scripts/one-number/backfill.mjs --target dev --apply
 *   ... --service-sid MGxxxxxxxx        copy scoped opt-outs to the shared line's Messaging Service
 *   ... --only contacts,aliases,stamps,consent
 *   ... --stamp-conversations           also stamp sms_projection_conversations.workspace_id (off by default)
 *   ... --undo <journal.json> --apply   take back exactly what a previous --apply wrote
 *
 * What it does (every part additive, every part safe to run twice):
 *   contacts   profiles + manager_sms_contacts -> sms_phone_contacts (E.164, one row per phone). A contact gets a
 *              user_id only when exactly one profile claims that phone and its phone is verified.
 *   aliases    every conversation's legacy key -> sms_projection_aliases (merged conversations alias their survivor).
 *   stamps     workspace_id on sms_projection_turns / sms_outbox / sms_inbound_receipts / manager_sms_messages /
 *              inbound_sms_log / manager_sms_contacts, from the conversation, the work line, then the owner's
 *              default workspace. Only NULLs are filled, only with a workspace the row's own owner holds.
 *   consent    a scoped-only REVOKE (consent withdrawn for one team in the product) under any messaging service is
 *              copied to the shared line's service so the move cannot undo it. Grants are never copied. A phone
 *              opted out in the global ledger (sms_consent, profile flags) is skipped: that block is phone-global,
 *              already stops every line, and a later START lifts it.
 *
 * Nothing is deleted or overwritten. Production needs every guard (see lib/target.mjs).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { optedOutKeys } from "./lib/consent.mjs";
import { chunk, fetchAll } from "./lib/db.mjs";
import { BACKUP_DIR, timestamp, writeJsonFile } from "./lib/files.mjs";
import { normalizeE164, phoneKey } from "./lib/phones.mjs";
import { UsageError } from "./lib/args.mjs";
import { bootstrap, isMain, runMain } from "./lib/runtime.mjs";
import { STAMP_TABLES, buildWorkspaceIndex, contactWorkspaceMap, planStamps } from "./lib/stamp-plan.mjs";

const SCRIPT = "backfill";
const PARTS = ["contacts", "aliases", "stamps", "consent"];
const BATCH = 200;
const SOURCE = "one_number_migration";

const CONVERSATION_STAMP = {
  table: "sms_projection_conversations",
  key: "id",
  owner: "owner_manager_user_id",
  select: "id, owner_manager_user_id, work_line_id",
  derive(row, ctx) {
    const owner = row.owner_manager_user_id;
    const viaLine = ctx.index.workspaceForNumberId(owner, row.work_line_id);
    if (viaLine) return { workspaceId: viaLine, rule: "work_line" };
    if (ctx.index.owns(owner, row.work_line_id)) return { workspaceId: row.work_line_id, rule: "shared_line" };
    return { workspaceId: ctx.index.ownerDefault(owner), rule: "owner_default" };
  },
};

/* ---------------------------------- contacts ---------------------------------- */

export function planContacts({ profiles, managerContacts, existing }) {
  const existingE164 = new Set(existing.map((c) => c.phone_e164));
  const existingKeys = new Set(existing.map((c) => c.phone_key));
  const byKey = new Map();
  const bump = (key, e164) => {
    let entry = byKey.get(key);
    if (!entry) {
      entry = { phone_e164: e164, phone_key: key, verifiedUsers: new Set(), allUsers: new Set(), name: null, managerName: null };
      byKey.set(key, entry);
    }
    return entry;
  };
  let invalid = 0;
  for (const p of profiles) {
    const e164 = normalizeE164(p.phone);
    if (!e164) {
      if (p.phone !== null && p.phone !== undefined && String(p.phone).trim() !== "") invalid += 1;
      continue;
    }
    const entry = bump(phoneKey(e164), e164);
    entry.allUsers.add(p.id);
    if (p.phone_verified_at) entry.verifiedUsers.add(p.id);
    const name = String(p.full_name ?? "").trim();
    if (!entry.name && name) entry.name = name;
  }
  for (const c of managerContacts) {
    const e164 = normalizeE164(c.phone_e164);
    if (!e164) {
      invalid += 1;
      continue;
    }
    const entry = bump(phoneKey(e164), e164);
    const name = String(c.display_name ?? "").trim();
    if (!entry.managerName && name) entry.managerName = name;
  }
  const inserts = [];
  let alreadyThere = 0;
  let ambiguousUser = 0;
  for (const entry of byKey.values()) {
    if (existingE164.has(entry.phone_e164) || existingKeys.has(entry.phone_key)) {
      alreadyThere += 1;
      continue;
    }
    // A phone claimed by two accounts matches nobody; an unverified phone is not proof of who holds it.
    let userId = null;
    if (entry.verifiedUsers.size === 1 && entry.allUsers.size === 1) userId = [...entry.verifiedUsers][0];
    else if (entry.allUsers.size > 1) ambiguousUser += 1;
    const display = (entry.managerName ?? entry.name ?? "").slice(0, 80).trim();
    inserts.push({ phone_e164: entry.phone_e164, phone_key: entry.phone_key, user_id: userId, display_name: display || null });
  }
  return { inserts, alreadyThere, invalid, ambiguousUser, candidates: byKey.size };
}

/* ----------------------------------- aliases ----------------------------------- */

export function planAliases({ conversations, aliases }) {
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const have = new Set(aliases.map((a) => aliasTuple(a.owner_manager_user_id, a.counterparty_role, a.work_line_id, a.alias_kind, a.alias_value)));
  const inserts = [];
  let alreadyThere = 0;
  let noKey = 0;
  for (const conv of conversations) {
    const legacy = String(conv.legacy_conversation_key ?? "").trim();
    if (!legacy) {
      noKey += 1;
      continue;
    }
    let target = conv;
    for (let hops = 0; target.merged_into_id && hops < 8; hops += 1) {
      const next = byId.get(target.merged_into_id);
      if (!next) break;
      target = next;
    }
    const tuple = aliasTuple(conv.owner_manager_user_id, conv.counterparty_role, conv.work_line_id, "legacy_key", legacy);
    if (have.has(tuple)) {
      alreadyThere += 1;
      continue;
    }
    have.add(tuple);
    inserts.push({
      owner_manager_user_id: conv.owner_manager_user_id,
      counterparty_role: conv.counterparty_role,
      work_line_id: conv.work_line_id,
      alias_kind: "legacy_key",
      alias_value: legacy,
      conversation_id: target.id,
      source_owner_id: null,
    });
  }
  return { inserts, alreadyThere, noKey };
}

function aliasTuple(owner, role, line, kind, value) {
  return [owner, role, line, kind, value].join("|");
}

/* ------------------------------------ consent ---------------------------------- */

const scopeOf = (e) => [e.recipient_phone_key, e.manager_user_id, e.purpose, e.send_class, e.conversation_key ?? ""].join("|");
const when = (e) => Date.parse(e.occurred_at ?? e.created_at ?? 0) || 0;

/**
 * Revoked events to mirror onto the shared service: one per scope whose latest evidence, anywhere, is a revoke.
 *
 * A phone that is opted out in the GLOBAL ledger right now is skipped: that block already stops every send on
 * every line, and a later START lifts it. Copying such a revoke onto the shared service would outlive the START
 * (the START webhook on the shared number carries no manager, so nothing restores scoped grants). What is
 * copied are the scoped-only withdrawals (a vendor or resident pulled consent for one team in the product),
 * which only a fresh grant lifts, exactly as before the move.
 */
export function planScopedOptOuts({ events, sharedSid, globallyOptedOut = new Set() }) {
  const latestAny = new Map();
  const latestShared = new Map();
  for (const e of events) {
    const key = scopeOf(e);
    const bucket = e.messaging_service_sid === sharedSid ? latestShared : latestAny;
    const prior = bucket.get(key);
    if (!prior || when(e) >= when(prior)) bucket.set(key, e);
  }
  const inserts = [];
  let alreadyCovered = 0;
  let coveredByGlobal = 0;
  for (const [key, latest] of latestAny) {
    if (latest.event_type !== "revoked") continue;
    if (globallyOptedOut.has(latest.recipient_phone_key)) {
      coveredByGlobal += 1;
      continue;
    }
    const shared = latestShared.get(key);
    if (shared && when(shared) >= when(latest)) {
      // Covered: the shared scope already says revoked, or the person re-granted there after the revoke.
      alreadyCovered += 1;
      continue;
    }
    inserts.push({
      recipient_phone_key: latest.recipient_phone_key,
      manager_user_id: latest.manager_user_id,
      messaging_service_sid: sharedSid,
      campaign_sid: null,
      purpose: latest.purpose,
      send_class: latest.send_class,
      conversation_key: latest.conversation_key ?? null,
      event_type: "revoked",
      source: SOURCE,
      wording_version: latest.wording_version ?? null,
      evidence: { copiedFromEventId: latest.id ?? null, copiedFromServiceSid: latest.messaging_service_sid ?? null },
      occurred_at: latest.occurred_at ?? latest.created_at ?? new Date().toISOString(),
    });
  }
  return { inserts, alreadyCovered, coveredByGlobal };
}

/* ------------------------------------- run ------------------------------------- */

export async function run(argv, deps = {}) {
  const { flags, resolved, db, log } = bootstrap(
    SCRIPT,
    argv,
    {
      booleans: ["stamp-conversations"],
      strings: ["only", "service-sid", "undo", "journal-out"],
    },
    { write: (f) => Boolean(f.apply), deps },
  );
  const apply = Boolean(flags.apply);
  const only = flags.only ? flags.only.split(",").map((s) => s.trim()).filter(Boolean) : PARTS;
  for (const part of only) if (!PARTS.includes(part)) throw new UsageError(`--only: unknown part "${part}" (use ${PARTS.join(", ")})`);
  const report = deps.report ?? {};
  const journal = { kind: "one-number-backfill-journal", target: resolved.target, ref: resolved.ref, createdAt: new Date(deps.now ?? Date.now()).toISOString(), contacts: [], aliases: [], consentEvents: [], stamps: {} };
  const journalPath = flags["journal-out"] ?? join(BACKUP_DIR, `one-number-backfill-journal-${resolved.target}-${timestamp(new Date(deps.now ?? Date.now()))}.json`);

  if (flags.undo) {
    if (!apply) {
      log(`${SCRIPT}: --undo is a write; add --apply to take the journal back. Dry run: nothing changed.`);
      return 0;
    }
    return undo(db, JSON.parse((deps.readFile ?? ((p) => readFileSync(p, "utf8")))(flags.undo)), resolved, log);
  }

  const done = (name) => only.includes(name);
  let failed = null;
  try {
    if (done("contacts")) await contactsPart(db, { apply, journal, report, log });
    if (done("aliases")) await aliasesPart(db, { apply, journal, report, log });
    if (done("stamps")) await stampsPart(db, { apply, journal, report, log, withConversations: Boolean(flags["stamp-conversations"]) });
    if (done("consent")) await consentPart(db, { apply, journal, report, log, sid: await sharedSid(db, flags["service-sid"]) });
  } catch (error) {
    failed = error;
  }
  if (apply) {
    (deps.writeFile ?? writeJsonFile)(journalPath, journal);
    log(`${SCRIPT}: journal ${journalPath} (undo with --undo <that file> --apply)`);
  } else {
    log(`${SCRIPT}: dry run, nothing written. Re-run with --apply to write.`);
  }
  if (failed) throw failed;
  return 0;
}

async function sharedSid(db, flagSid) {
  if (flagSid) return String(flagSid).trim();
  const { rows } = await fetchAll(db, "sms_runtime_config", "singleton, shared_messaging_service_sid", { key: "singleton" });
  return String(rows[0]?.shared_messaging_service_sid ?? "").trim() || null;
}

async function contactsPart(db, { apply, journal, report, log }) {
  const [profiles, managerContacts, existing] = await Promise.all([
    fetchAll(db, "profiles", "id, phone, phone_verified_at, full_name", { filter: (q) => q.not("phone", "is", null) }),
    fetchAll(db, "manager_sms_contacts", "id, phone_e164, display_name"),
    fetchAll(db, "sms_phone_contacts", "phone_e164, phone_key", { key: "phone_e164" }),
  ]);
  if (existing.missing) {
    log(`${SCRIPT}: contacts: sms_phone_contacts is not migrated here (run db:push first). Skipped.`);
    report.contacts = { skipped: "no_table" };
    return;
  }
  const plan = planContacts({ profiles: profiles.rows, managerContacts: managerContacts.rows, existing: existing.rows });
  report.contacts = { planned: plan.inserts.length, alreadyThere: plan.alreadyThere, invalid: plan.invalid, ambiguousUser: plan.ambiguousUser, candidates: plan.candidates };
  log(`${SCRIPT}: contacts: ${plan.candidates} phones seen, ${plan.alreadyThere} already contacts, ${plan.inserts.length} to add (${plan.inserts.filter((r) => r.user_id).length} with a verified account), ${plan.invalid} unusable numbers skipped, ${plan.ambiguousUser} phones claimed by several accounts left unowned`);
  if (!apply) return;
  for (const batch of chunk(plan.inserts, 500)) {
    const { data, error } = await db.from("sms_phone_contacts").upsert(batch, { onConflict: "phone_e164", ignoreDuplicates: true }).select("phone_e164");
    if (error) throw new Error(`sms_phone_contacts: ${error.message}`);
    journal.contacts.push(...(data ?? []).map((r) => r.phone_e164));
  }
  report.contacts.written = journal.contacts.length;
}

async function aliasesPart(db, { apply, journal, report, log }) {
  const [conversations, aliases] = await Promise.all([
    fetchAll(db, "sms_projection_conversations", "id, owner_manager_user_id, counterparty_role, work_line_id, legacy_conversation_key, merged_into_id"),
    fetchAll(db, "sms_projection_aliases", "id, owner_manager_user_id, counterparty_role, work_line_id, alias_kind, alias_value"),
  ]);
  if (conversations.missing || aliases.missing) {
    log(`${SCRIPT}: aliases: the projection tables are not migrated here. Skipped.`);
    report.aliases = { skipped: "no_table" };
    return;
  }
  const plan = planAliases({ conversations: conversations.rows, aliases: aliases.rows });
  report.aliases = { planned: plan.inserts.length, alreadyThere: plan.alreadyThere, noKey: plan.noKey };
  log(`${SCRIPT}: aliases: ${conversations.rows.length} conversations, ${plan.alreadyThere} legacy keys already aliased, ${plan.inserts.length} to alias, ${plan.noKey} without a legacy key`);
  if (!apply) return;
  for (const batch of chunk(plan.inserts, 500)) {
    const { data, error } = await db
      .from("sms_projection_aliases")
      .upsert(batch, { onConflict: "owner_manager_user_id,counterparty_role,work_line_id,alias_kind,alias_value", ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(`sms_projection_aliases: ${error.message}`);
    journal.aliases.push(...(data ?? []).map((r) => r.id));
  }
  report.aliases.written = journal.aliases.length;
}

async function loadIndex(db) {
  const [workspaces, numbers, links] = await Promise.all([
    fetchAll(db, "portal_workspaces", "id, owner_user_id, is_default, created_at"),
    fetchAll(db, "manager_sms_numbers", "id, manager_user_id, phone_number, workspace_id"),
    fetchAll(db, "workspace_work_numbers", "workspace_id, number_id, is_primary", { key: "number_id", offsetPaging: true }),
  ]);
  return buildWorkspaceIndex({ workspaces: workspaces.rows, numbers: numbers.rows, links: links.rows });
}

async function stampsPart(db, { apply, journal, report, log, withConversations }) {
  const index = await loadIndex(db);
  const conversations = await fetchAll(db, "sms_projection_conversations", "id, workspace_id, work_line_id");
  const ctx = { index, conversations: new Map(conversations.rows.map((c) => [c.id, c])), contactWorkspace: new Map() };
  let plannedMessages = { rows: [], workspaceById: new Map() };
  report.stamps = {};
  const specs = [...(withConversations ? [CONVERSATION_STAMP] : []), ...STAMP_TABLES];
  for (const spec of specs) {
    const unstamped = await fetchAll(db, spec.table, spec.select, { key: spec.key, filter: (q) => q.is("workspace_id", null) });
    if (unstamped.missing) {
      log(`${SCRIPT}: stamps: ${spec.table} has no workspace_id here (run db:push first). Skipped.`);
      report.stamps[spec.table] = { skipped: "no_column" };
      continue;
    }
    if (spec.table === "manager_sms_contacts") {
      // A contact lands where its thread already lives: use stamped messages (including those stamped a moment ago).
      const stamped = await fetchAll(db, "manager_sms_messages", "id, manager_user_id, resident_phone, workspace_id", { filter: (q) => q.not("workspace_id", "is", null) });
      const justPlanned = plannedMessages.rows.map((r) => ({ ...r, workspace_id: plannedMessages.workspaceById.get(r.id) ?? null }));
      ctx.contactWorkspace = contactWorkspaceMap([...stamped.rows, ...justPlanned]);
    }
    const plan = planStamps(spec, unstamped.rows, ctx);
    if (spec.table === "manager_sms_messages") {
      plannedMessages = { rows: unstamped.rows, workspaceById: new Map(plan.updates.map((u) => [u.key, u.workspaceId])) };
    }
    const byReason = plan.skipped.reduce((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] ?? 0) + 1 }), {});
    report.stamps[spec.table] = { unstamped: unstamped.rows.length, planned: plan.updates.length, rules: plan.rules, skipped: byReason };
    log(`${SCRIPT}: stamps: ${spec.table}: ${unstamped.rows.length} unstamped, ${plan.updates.length} to stamp ${JSON.stringify(plan.rules)}${plan.skipped.length ? `, ${plan.skipped.length} left (${JSON.stringify(byReason)})` : ""}`);
    if (!apply || plan.updates.length === 0) continue;
    const groups = new Map();
    for (const u of plan.updates) {
      const list = groups.get(u.workspaceId) ?? [];
      list.push(u.key);
      groups.set(u.workspaceId, list);
    }
    journal.stamps[spec.table] = {};
    let written = 0;
    for (const [workspaceId, keys] of groups) {
      for (const batch of chunk(keys, BATCH)) {
        const { data, error } = await db
          .from(spec.table)
          .update({ workspace_id: workspaceId })
          .in(spec.key, batch)
          .is("workspace_id", null)
          .select(spec.key);
        if (error) throw new Error(`${spec.table}: ${error.message}`);
        const done = (data ?? []).map((r) => r[spec.key]);
        (journal.stamps[spec.table][workspaceId] ??= []).push(...done);
        written += done.length;
      }
    }
    report.stamps[spec.table].written = written;
  }
}

async function consentPart(db, { apply, journal, report, log, sid }) {
  const global = await fetchAll(db, "sms_consent", "phone, opted_in_at, opted_out_at", { key: "phone" });
  const optedOut = global.rows.filter((r) => r.opted_out_at && (!r.opted_in_at || Date.parse(r.opted_in_at) < Date.parse(r.opted_out_at))).length;
  log(`${SCRIPT}: consent: ${optedOut} phones are opted out in the global ledger; that ledger is phone-global and applies on the shared line as is`);
  report.consent = { globalOptedOut: optedOut };
  if (!sid) {
    log(`${SCRIPT}: consent: scoped copy SKIPPED (no shared Messaging Service SID: pass --service-sid or set sms_runtime_config.shared_messaging_service_sid, then run again)`);
    report.consent.skipped = "no_service_sid";
    return;
  }
  const events = await fetchAll(
    db,
    "sms_consent_events",
    "id, recipient_phone_key, manager_user_id, messaging_service_sid, purpose, send_class, conversation_key, event_type, wording_version, occurred_at, created_at",
  );
  if (events.missing) {
    report.consent.skipped = "no_table";
    return;
  }
  const plan = planScopedOptOuts({ events: events.rows, sharedSid: sid, globallyOptedOut: await optedOutKeys(db) });
  report.consent.planned = plan.inserts.length;
  report.consent.alreadyCovered = plan.alreadyCovered;
  report.consent.coveredByGlobal = plan.coveredByGlobal;
  log(`${SCRIPT}: consent: ${plan.alreadyCovered} scoped opt-outs already hold on ${sid}, ${plan.coveredByGlobal} are covered by the global STOP ledger, ${plan.inserts.length} to copy (scoped-only revokes)`);
  if (!apply) return;
  for (const batch of chunk(plan.inserts, 500)) {
    const { data, error } = await db.from("sms_consent_events").insert(batch).select("id");
    if (error) throw new Error(`sms_consent_events: ${error.message}`);
    journal.consentEvents.push(...(data ?? []).map((r) => r.id));
  }
  report.consent.written = journal.consentEvents.length;
}

async function undo(db, journal, resolved, log) {
  if (journal?.kind !== "one-number-backfill-journal") throw new UsageError("That file is not a backfill journal.");
  if (journal.ref !== resolved.ref) throw new UsageError(`That journal is for project ${journal.ref}, not ${resolved.ref}.`);
  let removed = 0;
  for (const batch of chunk(journal.consentEvents ?? [], BATCH)) {
    const { error } = await db.from("sms_consent_events").delete().in("id", batch);
    if (error) throw new Error(`sms_consent_events: ${error.message}`);
    removed += batch.length;
  }
  for (const batch of chunk(journal.aliases ?? [], BATCH)) {
    const { error } = await db.from("sms_projection_aliases").delete().in("id", batch);
    if (error) throw new Error(`sms_projection_aliases: ${error.message}`);
    removed += batch.length;
  }
  for (const batch of chunk(journal.contacts ?? [], BATCH)) {
    const { error } = await db.from("sms_phone_contacts").delete().in("phone_e164", batch);
    if (error) throw new Error(`sms_phone_contacts: ${error.message}`);
    removed += batch.length;
  }
  let unstamped = 0;
  for (const [table, groups] of Object.entries(journal.stamps ?? {})) {
    const key = STAMP_TABLES.find((s) => s.table === table)?.key ?? "id";
    for (const [workspaceId, keys] of Object.entries(groups)) {
      for (const batch of chunk(keys, BATCH)) {
        // Only rows still carrying the stamp we wrote: a later legitimate re-stamp is left alone.
        const { error } = await db.from(table).update({ workspace_id: null }).in(key, batch).eq("workspace_id", workspaceId);
        if (error) throw new Error(`${table}: ${error.message}`);
        unstamped += batch.length;
      }
    }
  }
  log(`${SCRIPT}: undo: removed ${removed} inserted rows, cleared ${unstamped} stamps`);
  return 0;
}

if (isMain(import.meta.url)) await runMain(SCRIPT, () => run(process.argv.slice(2)));
