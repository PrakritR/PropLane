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

async function del(db, table, column, values) {
  if (!values.length) return 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { error, count } = await db.from(table).delete({ count: "exact" }).in(column, values);
    if (!error) return count ?? 0;
    if (/does not exist|schema cache|Could not find/i.test(error.message ?? "")) return 0;
    // The shared dev database is busy: a statement timeout is retried, anything else is reported.
    if (attempt === 3 || !/timeout|fetch failed|ECONNRESET|50\d/i.test(error.message ?? "")) return { error: `${table}.${column}: ${error.message}` };
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

  // Rows keyed by house / workspace first (some are not account-owned).
  for (const [table, column, values] of [
    ["sms_entry_codes", "workspace_id", workspaceIds],
    ["manager_property_records", "id", houseIds],
    ["sms_unassigned_lead_turns", "phone_key", phoneKeys],
    ["sms_unassigned_leads", "phone_key", phoneKeys],
    ["sms_line_sessions", "phone_key", phoneKeys],
    ["sms_line_thread_state", "phone_key", phoneKeys],
    ["sms_moved_notices", "phone_key", phoneKeys],
    ["sms_consent", "phone_key", phoneKeys],
    ["sms_media_files", "sender_phone_key", phoneKeys],
    ["inbound_sms_log", "from_phone", e164s],
    ["manager_sms_contacts", "phone_e164", e164s],
    ["manager_sms_messages", "workspace_id", workspaceIds],
  ]) note(await del(db, table, column, values));
  // Receipts and logs written under the harness's synthetic MessageSids.
  for (const table of ["sms_inbound_receipts", "sms_onboarding_replies"]) {
    const { error } = await db.from(table).delete().like("message_sid", "SMe2e%");
    if (error && !/does not exist|schema cache|Could not find|column/i.test(error.message ?? "")) problems.push(`${table}: ${error.message}`);
  }

  // Account-owned rows, children first.
  const manifest = readManifest().sort((a, b) => a.phase - b.phase);
  for (const rule of manifest) {
    for (const [scope, ids] of [["manager", userIds], ["resident", userIds], ["vendor", userIds]]) {
      for (const column of rule[scope]) note(await del(db, rule.table, column, ids));
    }
  }
  // Workspace-keyed leftovers the manifest does not name.
  note(await del(db, "portal_workspaces", "id", workspaceIds));

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
  log(problems.length ? `cleanup finished with ${problems.length} note(s):\n  ${problems.slice(0, 12).join("\n  ")}` : "cleanup finished clean");
  return problems;
}
