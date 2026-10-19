/**
 * Removes everything a harness run created. Anchors are the fixture auth users (manager / resident /
 * vendor), their workspaces, house ids, phone numbers and the harness's MessageSids. Account-owned rows are
 * found through the account-purge manifest (every table that ties a row to an account), then the
 * phone-keyed SMS tables are swept by the fixture phones, then the auth users go.
 */
import { readFileSync } from "node:fs";

const MANIFEST = new URL("../../../src/lib/auth/account-purge-manifest.ts", import.meta.url);

/** [{ table, phase, manager: [cols], resident: [cols], vendor: [cols] }] read from the manifest source. */
export function readManifest() {
  const src = readFileSync(MANIFEST, "utf8");
  const body = src.slice(src.indexOf("ACCOUNT_PURGE_TABLES"));
  const idCols = (chunk, scope) => {
    const scopeMatch = new RegExp(`\\b${scope}:\\s*\\{([\\s\\S]*?)\\n\\s{4}\\}`).exec(chunk) ?? new RegExp(`\\b${scope}:\\s*\\{([^}]*)\\}`).exec(chunk);
    if (!scopeMatch) return [];
    const ids = /\bids:\s*\[([^\]]*)\]/.exec(scopeMatch[1]);
    return ids ? [...ids[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];
  };
  return body
    .split(/\n\s*table:\s*"/)
    .slice(1)
    .map((chunk) => ({
      table: chunk.slice(0, chunk.indexOf('"')),
      phase: Number(/\bphase:\s*(\d)/.exec(chunk)?.[1] ?? 3),
      manager: idCols(chunk, "manager"),
      resident: idCols(chunk, "resident"),
      vendor: idCols(chunk, "vendor"),
    }));
}

/**
 * Run the tasks ONE AT A TIME with a short pause between them. The shared dev database was knocked over by a parallel reap
 * (many DELETEs across the purge manifest at once), so cleanup is strictly sequential: one table, one small batch, a sleep.
 */
const PAUSE_MS = 150;
const BATCH = 20;
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
async function pool(tasks, _ignoredConcurrency, each) {
  for (const task of tasks) {
    await each(await task());
    await nap(PAUSE_MS);
  }
}

async function del(db, table, column, values) {
  if (!values.length) return 0;
  let total = 0;
  for (let i = 0; i < values.length; i += BATCH) {
    const batch = values.slice(i, i + BATCH);
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt += 1) {
      const { error, count } = await db.from(table).delete({ count: "exact" }).in(column, batch);
      if (!error) { total += count ?? 0; done = true; break; }
      if (/does not exist|schema cache|Could not find/i.test(error.message ?? "")) { done = true; break; }
      // The shared dev database is busy: a timeout is retried with a growing pause, anything else is reported.
      if (attempt === 3 || !/timeout|deadlock|fetch failed|ECONNRESET|50\d/i.test(error.message ?? "")) return { error: `${table}.${column}: ${error.message}` };
      await nap(3000 * (attempt + 1));
    }
    await nap(PAUSE_MS);
  }
  return total;
}

export async function cleanup(db, fx, log = () => {}) {
  const problems = [];
  const note = (r) => { if (r && typeof r === "object" && r.error) problems.push(r.error); };
  const userIds = [...new Set(fx.userIds)];
  const workspaceIds = [...new Set(fx.workspaceIds)];
  const houseIds = [...new Set(fx.houseIds)];
  const phoneKeys = [...new Set(fx.phones.map((p) => p.replace(/\D/g, "").slice(-10)))];
  const e164s = phoneKeys.map((k) => `+1${k}`);

  const jobs = [];
  // Rows keyed by house / workspace / phone first (some are not account-owned).
  for (const [table, column, values] of [
    ["sms_entry_codes", "workspace_id", workspaceIds],
    ["sms_unassigned_lead_turns", "phone_key", phoneKeys],
    ["sms_unassigned_leads", "phone_key", phoneKeys],
    ["sms_line_sessions", "phone_key", phoneKeys],
    ["sms_line_thread_state", "phone_key", phoneKeys],
    ["sms_moved_notices", "phone_key", phoneKeys],
    ["sms_consent", "phone", [...e164s, ...phoneKeys]],
    ["sms_consent_events", "recipient_phone_key", phoneKeys],
    ["sms_control_receipts", "recipient_phone_key", phoneKeys],
    ["sms_media_files", "sender_phone_key", phoneKeys],
    ["inbound_sms_log", "from_phone", e164s],
    ["manager_sms_contacts", "phone_e164", e164s],
    ["manager_sms_numbers", "phone_number", e164s],
    ["manager_sms_messages", "workspace_id", workspaceIds],
    ["prospect_sms_bursts", "counterparty_phone_e164", e164s],
    ["sms_outbox", "recipient_phone", e164s],
  ]) jobs.push(() => del(db, table, column, values));
  for (const table of ["sms_inbound_receipts", "sms_onboarding_replies"]) {
    jobs.push(async () => {
      const { error } = await db.from(table).delete().like("message_sid", "SMe2e%");
      return error && !/does not exist|schema cache|Could not find|column/i.test(error.message ?? "") ? { error: `${table}: ${error.message}` } : 0;
    });
  }
  await pool(jobs, 1, note);

  // Account-owned rows. The auth user goes first: nearly every account table cascades from it. The manifest sweep after it
  // catches what does not (set-null columns, tables keyed by workspace owner), phase by phase, tables in parallel.
  for (const id of userIds) {
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { error } = await db.auth.admin.deleteUser(id);
      if (!error || /not found/i.test(error.message ?? "")) { lastError = null; break; }
      lastError = error;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
    if (lastError) problems.push(`auth user ${id} NOT deleted (${lastError.message || JSON.stringify(lastError)}); run --sweep`);
  }
  const manifest = readManifest();
  for (const phase of [1, 2, 3, 4]) {
    const tasks = [];
    for (const rule of manifest.filter((r) => r.phase === phase)) {
      for (const scope of ["manager", "resident", "vendor"]) for (const column of rule[scope]) tasks.push(() => del(db, rule.table, column, userIds));
    }
    await pool(tasks, 1, note);
  }
  await pool([() => del(db, "manager_property_records", "id", houseIds), () => del(db, "portal_workspaces", "id", workspaceIds)], 1, note);

  // Private media written for the fixture owners.
  for (const id of userIds) {
    try {
      const { data: sids } = await db.storage.from("sms-media").list(`manager/${id}`, { limit: 1000 });
      for (const sid of sids ?? []) {
        const { data: files } = await db.storage.from("sms-media").list(`manager/${id}/${sid.name}`, { limit: 1000 });
        const paths = (files ?? []).map((f) => `manager/${id}/${sid.name}/${f.name}`);
        if (paths.length) await db.storage.from("sms-media").remove(paths);
      }
    } catch { /* bucket absent */ }
  }

  log(problems.length ? `cleanup finished with ${problems.length} note(s):\n  ${problems.slice(0, 12).join("\n  ")}` : "cleanup finished clean");
  return problems;
}
