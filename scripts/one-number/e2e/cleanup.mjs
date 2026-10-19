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

/** Run async tasks with at most `n` in flight (the shared dev API is slow; one at a time would take an hour). */
async function pool(tasks, n, each) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await each(await task());
    }
  }));
}

async function del(db, table, column, values) {
  if (!values.length) return 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { error, count } = await db.from(table).delete({ count: "exact" }).in(column, values);
    if (!error) return count ?? 0;
    if (/does not exist|schema cache|Could not find/i.test(error.message ?? "")) return 0;
    // The shared dev database is busy: a statement timeout is retried, anything else is reported.
    if (attempt === 3 || !/timeout|deadlock|fetch failed|ECONNRESET|50\d/i.test(error.message ?? "")) return { error: `${table}.${column}: ${error.message}` };
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  return 0;
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
    ["sms_vendor_leads", "phone_key", phoneKeys],
    ["sms_setup_links", "phone_key", phoneKeys],
    ["sms_onboarding_state", "phone_key", phoneKeys],
    ["agent_sessions", "vendor_phone_e164", e164s],
    ["sms_line_sessions", "phone_key", phoneKeys],
    ["sms_line_thread_state", "phone_key", phoneKeys],
    ["sms_moved_notices", "phone_key", phoneKeys],
    ["sms_consent", "phone", [...e164s, ...phoneKeys]],
    ["sms_consent_events", "recipient_phone_key", phoneKeys],
    ["sms_control_receipts", "recipient_phone_key", phoneKeys],
    ["sms_media_files", "sender_phone_key", phoneKeys],
    ["inbound_sms_log", "from_phone", e164s],
    ["manager_sms_contacts", "phone_e164", e164s],
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
  await pool(jobs, 8, note);

  // Account-owned rows, phase by phase (children first), tables in parallel.
  const manifest = readManifest();
  for (const phase of [1, 2, 3, 4]) {
    const tasks = [];
    for (const rule of manifest.filter((r) => r.phase === phase)) {
      for (const scope of ["manager", "resident", "vendor"]) for (const column of rule[scope]) tasks.push(() => del(db, rule.table, column, userIds));
    }
    await pool(tasks, 12, note);
  }
  await pool([() => del(db, "manager_property_records", "id", houseIds), () => del(db, "portal_workspaces", "id", workspaceIds)], 2, note);

  // The login goes LAST: deleting it first cascades through every account table inside one auth call, which times out on a busy database.
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
