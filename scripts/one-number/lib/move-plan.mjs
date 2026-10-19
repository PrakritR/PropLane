/**
 * Decision logic and read-only snapshots for move-houses-to-service.mjs (W22). No writes live here.
 *
 * The move itself is the app's own `transfer_portal_workspace_ownership` RPC (migrations 20260921000000 and
 * 20261012121000), which re-keys the workspace, its houses, twelve property-keyed tables, its members, and its work
 * number/email. This file decides WHAT may move (a workspace whose every house is in the city) and PROVES the result
 * (a before/after snapshot of every table that carries a house id, plus the rows the RPC does not touch).
 */
import { chunk, fetchAll } from "./db.mjs";

/** The permission stamp of the "admin" team role (src/lib/co-manager-team-roles.ts, `allModules("manage")`). A test pins it. */
export const ADMIN_STAMP = Object.freeze({
  properties: true,
  applications: true,
  residents: true,
  leases: true,
  payments: true,
  bankAccount: true,
  documents: true,
  financials: true,
  services: true,
  promotion: true,
  inbox: true,
  calendar: true,
  teams: true,
});

/** Tables the RPC re-keys (manager_user_id) by property_id; a test pins this to the migration. */
export const MOVED_PROPERTY_TABLES = Object.freeze([
  "manager_application_records",
  "portal_lease_pipeline_records",
  "portal_household_charge_records",
  "portal_recurring_rent_profile_records",
  "portal_work_order_records",
  "portal_schedule_records",
  "screening_orders",
  "cosigner_submission_records",
  "ledger_entries",
  "manager_expense_entries",
  "portal_scheduled_inbox_message_records",
  "payment_automation_settings",
]);
/** Re-keyed by assigned_property_id as well. */
export const MOVED_ASSIGNED_TABLES = Object.freeze(["manager_application_records", "portal_work_order_records"]);

/**
 * Tables that carry a house id and an owner column but that the RPC does NOT re-key (surveyed on dev, Oct 18).
 * They are read, counted before and after, and reported as "left behind" so the captain decides with the numbers.
 */
export const UNMOVED_PROPERTY_TABLES = Object.freeze([
  ["application_fee_payment_claims", "manager_user_id", "property_id"],
  ["application_fee_waiver_redemptions", "manager_user_id", "property_id"],
  ["external_calendar_connections", "manager_user_id", "property_id"],
  ["gl_journal_entries", "manager_user_id", "property_id"],
  ["listing_channel_posts", "manager_user_id", "property_id"],
  ["managed_rent_allocations", "owner_user_id", "property_id"],
  ["manager_application_fee_waiver_codes", "manager_user_id", "property_id"],
  ["manager_bills", "manager_user_id", "property_id"],
  ["manager_budgets", "manager_user_id", "property_id"],
  ["manager_documents", "manager_user_id", "property_id"],
  ["manager_expense_reversals", "manager_user_id", "property_id"],
  ["manager_house_public_links", "manager_user_id", "property_id"],
  ["manager_owner_distributions", "manager_user_id", "property_id"],
  ["manager_payment_plans", "manager_user_id", "property_id"],
  ["manager_property_access", "manager_user_id", "property_id"],
  ["manager_property_owners", "manager_user_id", "property_id"],
  ["manager_reserve_policies", "manager_user_id", "property_id"],
  ["manager_sms_conversation_houses", "manager_user_id", "property_id"],
  ["manager_vendor_preferences", "manager_user_id", "property_id"],
  ["owner_expenses", "owner_user_id", "property_id"],
  ["portal_service_request_records", "manager_user_id", "property_id"],
  ["property_utility_allocations", "manager_user_id", "property_id"],
  ["prospect_sms_tour_reminders", "manager_user_id", "property_id"],
  ["prospect_tour_scheduling_state", "manager_user_id", "property_id"],
  ["resident_inspections", "manager_user_id", "property_id"],
  ["resident_invite_claims", "owner_user_id", "property_id"],
  ["resident_move_in_forms", "manager_user_id", "property_id"],
  ["resident_rent_reporting", "manager_user_id", "property_id"],
  ["resident_tour_links", "manager_user_id", "property_id"],
  ["sales_migration_records", "manager_user_id", "property_id"],
  ["security_deposit_ledger", "manager_user_id", "property_id"],
  ["sms_ai_reply_drafts", "owner_user_id", "property_id"],
  ["sms_entry_codes", "owner_user_id", "property_id"],
  ["sms_escalated_questions", "owner_user_id", "property_id"],
  ["sms_outbox", "manager_user_id", "property_id"],
  ["tour_slot_reservations", "manager_user_id", "property_id"],
  ["vendor_dispatch_runs", "owner_user_id", "property_id"],
  ["workspace_automation_runs", "owner_user_id", "property_id"],
].map(([table, owner, prop]) => Object.freeze({ table, owner, prop })));

/** Workspace-keyed tables with an owner column the RPC does not re-key (history stays attached to the workspace id). */
export const UNMOVED_WORKSPACE_TABLES = Object.freeze([
  ["agent_sessions", "landlord_id"],
  ["inbound_sms_log", "manager_user_id"],
  ["lease_document_library", "manager_user_id"],
  ["listing_channel_connections", "manager_user_id"],
  ["managed_workspace_fee_policies", "owner_user_id"],
  ["manager_comms_credit_purchases", "manager_user_id"],
  ["manager_comms_usage_events", "manager_user_id"],
  ["manager_comms_workspace_wallets", "manager_user_id"],
  ["manager_invite_links", "owner_user_id"],
  ["manager_sms_contacts", "manager_user_id"],
  ["manager_sms_messages", "manager_user_id"],
  ["manager_syndication_feeds", "manager_user_id"],
  ["meta_messenger_replies", "manager_user_id"],
  ["owner_statements", "owner_user_id"],
  ["portal_inbox_thread_records", "owner_user_id"],
  ["sms_inbound_receipts", "manager_user_id"],
  ["sms_projection_conversations", "owner_manager_user_id"],
  ["sms_projection_turns", "owner_manager_user_id"],
  ["vendor_dispatch_rules", "owner_user_id"],
  ["vendor_marketplace_accounts", "manager_user_id"],
  ["vendor_work_number_conversations", "manager_user_id"],
  ["workspace_automation_settings", "owner_user_id"],
].map(([table, owner]) => Object.freeze({ table, owner })));

/* ------------------------------------ city ------------------------------------ */

const STATE_ZIP = /^([A-Za-z]{2})(\s+\d{5}(-\d{4})?)?$/;
const CITY_STATE_ZIP = /^(.+?)\s+([A-Za-z]{2})\s+\d{5}(-\d{4})?$/;

function clean(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

/**
 * The city of one house record, or null when it cannot be told. An explicit city field wins; otherwise the
 * address is read as "street, City, ST 12345" (or "street, City ST 12345"). Never guessed: no city = null.
 */
export function houseCity(row) {
  const pd = row?.property_data && typeof row.property_data === "object" ? row.property_data : {};
  const rd = row?.row_data && typeof row.row_data === "object" ? row.row_data : {};
  const explicit = [pd.city, pd.listingSubmission?.city, rd.city, rd.submission?.city, rd.listingSubmission?.city]
    .map(clean)
    .find(Boolean);
  if (explicit) return explicit;
  const address = [pd.address, rd.address, pd.listingSubmission?.address, rd.submission?.address].map(clean).find(Boolean);
  if (!address) return null;
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3 && STATE_ZIP.test(parts[parts.length - 1])) return parts[parts.length - 2];
  if (parts.length >= 2) {
    const m = CITY_STATE_ZIP.exec(parts[parts.length - 1]);
    if (m) return m[1].trim();
  }
  return null;
}

export const sameCity = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase() && clean(a) !== "";

export function houseLabel(row) {
  const pd = row?.property_data && typeof row.property_data === "object" ? row.property_data : {};
  const rd = row?.row_data && typeof row.row_data === "object" ? row.row_data : {};
  return clean(pd.address) || clean(rd.address) || clean(pd.title) || clean(pd.buildingName) || String(row?.id ?? "");
}

/**
 * Group an owner's houses by workspace and sort each workspace into: every house in the city (movable), none in the
 * city (not a candidate), or a mix / an unreadable address (STOP: never split automatically).
 */
export function classifyWorkspaces(workspaces, houses, city) {
  const byWs = new Map(workspaces.map((w) => [w.id, { workspace: w, houses: [], inCity: 0, elsewhere: [], unknown: [] }]));
  for (const house of houses) {
    const entry = byWs.get(house.workspace_id);
    if (!entry) continue;
    const c = houseCity(house);
    entry.houses.push({ ...house, city: c });
    if (c === null) entry.unknown.push(house.id);
    else if (sameCity(c, city)) entry.inCity += 1;
    else entry.elsewhere.push(house.id);
  }
  return [...byWs.values()].map((e) => ({
    ...e,
    candidate: e.inCity > 0,
    movable: e.inCity > 0 && e.elsewhere.length === 0 && e.unknown.length === 0,
    mixed: e.inCity > 0 && (e.elsewhere.length > 0 || e.unknown.length > 0),
  }));
}

/* --------------------------------- snapshots ---------------------------------- */

const CLOSED_LEASE = new Set(["terminated", "expired", "ended", "cancelled", "canceled", "declined", "void", "voided", "archived"]);
const OPEN_CHARGE = new Set(["pending", "overdue", "failed", "unpaid", "open", "partial"]);

const EXTRAS = {
  portal_lease_pipeline_records: ["status", "resident_email"],
  portal_household_charge_records: ["status"],
  portal_schedule_records: ["record_type", "ends_at"],
};

function histogram(rows, col) {
  const out = {};
  for (const r of rows) {
    const k = String(r[col] ?? "");
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function perHouse(rows, prop, summarize) {
  const groups = {};
  for (const r of rows) (groups[r[prop]] ??= []).push(r);
  return Object.fromEntries(Object.entries(groups).map(([id, list]) => [id, summarize(list)]));
}

async function readPropertyRows(db, table, owner, prop, houseIds) {
  const extras = EXTRAS[table] ?? [];
  const attempt = async (cols) => {
    const rows = [];
    for (const batch of chunk(houseIds, 50)) {
      const res = await fetchAll(db, table, [...new Set(["id", owner, prop, ...cols])].join(", "), {
        key: prop,
        offsetPaging: true,
        filter: (q) => q.in(prop, batch),
      });
      if (res.missing) return null;
      rows.push(...res.rows);
    }
    return rows;
  };
  let rows = await attempt(extras);
  if (rows === null && extras.length) rows = await attempt([]);
  return rows;
}

/** Everything the move must leave unchanged (per house), plus who owns each row (checked separately). */
export async function readSnapshot(db, { workspaceId, houseIds, now = new Date() }) {
  const snap = { workspaceId, asOf: now.toISOString(), houses: [], tables: {}, workspaceKeyed: {}, members: [], numbers: [], emails: [], holds: [], missingTables: [] };

  const ws = await db
    .from("portal_workspaces")
    .select("id, owner_user_id, name, city, is_service, is_default, owner_of_record_name")
    .eq("id", workspaceId)
    .maybeSingle();
  if (ws.error) throw new Error(`portal_workspaces: ${ws.error.message}`);
  snap.workspace = ws.data ?? null;

  const houses = await fetchAll(db, "manager_property_records", "id, manager_user_id, workspace_id, status", {
    filter: (q) => q.eq("workspace_id", workspaceId),
  });
  snap.houses = houses.rows.map((h) => ({ id: h.id, workspace_id: h.workspace_id, status: h.status ?? null })).sort((a, b) => a.id.localeCompare(b.id));
  snap.houseOwners = histogram(houses.rows, "manager_user_id");
  const ids = houseIds;

  const specs = [
    ...MOVED_PROPERTY_TABLES.map((table) => ({ table, owner: "manager_user_id", prop: "property_id", moved: true })),
    ...MOVED_ASSIGNED_TABLES.map((table) => ({ table, owner: "manager_user_id", prop: "assigned_property_id", moved: true, label: `${table}#assigned` })),
    ...UNMOVED_PROPERTY_TABLES.map((s) => ({ ...s, moved: false })),
  ];
  const nowIso = now.toISOString();
  for (const spec of specs) {
    const label = spec.label ?? spec.table;
    const rows = await readPropertyRows(db, spec.table, spec.owner, spec.prop, ids);
    if (rows === null) {
      snap.missingTables.push(label);
      continue;
    }
    const byHouse = {};
    for (const r of rows) byHouse[r[spec.prop]] = (byHouse[r[spec.prop]] ?? 0) + 1;
    const entry = { moved: spec.moved, owner: spec.owner, count: rows.length, byHouse, byOwner: histogram(rows, spec.owner) };
    if (spec.table === "portal_lease_pipeline_records" && spec.prop === "property_id") {
      entry.status = histogram(rows, "status");
      entry.residents = [...new Set(rows.map((r) => String(r.resident_email ?? "").trim().toLowerCase()).filter(Boolean))].sort();
      entry.open = rows.filter((r) => !CLOSED_LEASE.has(String(r.status ?? "").trim().toLowerCase())).length;
      entry.perHouse = perHouse(rows, spec.prop, (list) => ({
        total: list.length,
        open: list.filter((r) => !CLOSED_LEASE.has(String(r.status ?? "").trim().toLowerCase())).length,
        residents: new Set(list.map((r) => String(r.resident_email ?? "").trim().toLowerCase()).filter(Boolean)).size,
      }));
    }
    if (spec.table === "portal_household_charge_records") {
      entry.status = histogram(rows, "status");
      entry.open = rows.filter((r) => OPEN_CHARGE.has(String(r.status ?? "").trim().toLowerCase())).length;
      entry.perHouse = perHouse(rows, spec.prop, (list) => ({
        total: list.length,
        open: list.filter((r) => OPEN_CHARGE.has(String(r.status ?? "").trim().toLowerCase())).length,
      }));
    }
    if (spec.table === "portal_schedule_records") {
      const blocks = rows.filter((r) => r.record_type === "room_date_block");
      entry.bookings = blocks.length;
      entry.upcomingBookings = blocks.filter((r) => r.ends_at && String(r.ends_at) >= nowIso).length;
      entry.recordTypes = histogram(rows, "record_type");
      entry.perHouse = perHouse(rows, spec.prop, (list) => {
        const b = list.filter((r) => r.record_type === "room_date_block");
        return { bookings: b.length, upcoming: b.filter((r) => r.ends_at && String(r.ends_at) >= nowIso).length };
      });
    }
    snap.tables[label] = entry;
  }

  for (const spec of UNMOVED_WORKSPACE_TABLES) {
    const total = await db.from(spec.table).select("*", { count: "exact", head: true }).eq("workspace_id", workspaceId);
    if (total.error) {
      snap.missingTables.push(spec.table);
      continue;
    }
    snap.workspaceKeyed[spec.table] = { owner: spec.owner, count: total.count ?? 0 };
  }

  const members = await fetchAll(db, "account_link_invites", "*", { filter: (q) => q.eq("workspace_id", workspaceId).in("status", ["pending", "accepted"]) });
  snap.memberRows = members.rows;
  snap.members = members.rows
    .map((m) => ({
      invitee: m.invitee_user_id,
      role: m.team_role ?? null,
      status: m.status,
      scope: m.house_scope ?? null,
      assigned: [...(Array.isArray(m.assigned_property_ids) ? m.assigned_property_ids : [])].sort(),
    }))
    .sort((a, b) => a.invitee.localeCompare(b.invitee));

  const numbers = await fetchAll(db, "manager_sms_numbers", "id, manager_user_id, phone_number, provision_state, released_at", {
    filter: (q) => q.eq("workspace_id", workspaceId),
  });
  snap.numbers = numbers.rows.map((n) => ({ id: n.id, phone_number: n.phone_number, provision_state: n.provision_state, released: Boolean(n.released_at) })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  snap.numberOwners = histogram(numbers.rows, "manager_user_id");
  snap.numberRows = numbers.rows;
  const emails = await fetchAll(db, "manager_assistant_emails", "id, manager_user_id, provision_state", { filter: (q) => q.eq("workspace_id", workspaceId) });
  snap.emails = emails.rows.map((e) => ({ id: e.id, provision_state: e.provision_state ?? null })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  snap.emailOwners = histogram(emails.rows, "manager_user_id");
  return snap;
}

/**
 * Differences that matter: everything except who owns a row. Pass `membersExtra` for the one membership the move
 * adds on purpose (the former owner, as Admin), and `ignoreMember` for one it removes (the service owner's own).
 */
export function diffSnapshots(before, after, { addedMembers = [], removedMembers = [] } = {}) {
  const diffs = [];
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!eq(before.houses, after.houses)) diffs.push("houses differ (ids, workspace or status)");
  for (const label of new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])) {
    const a = before.tables[label];
    const b = after.tables[label];
    if (!a || !b) {
      diffs.push(`${label}: readable on one side only`);
      continue;
    }
    for (const field of ["count", "byHouse", "perHouse", "status", "residents", "open", "bookings", "upcomingBookings", "recordTypes"]) {
      if (!eq(a[field], b[field])) diffs.push(`${label}.${field}: ${JSON.stringify(a[field])} -> ${JSON.stringify(b[field])}`);
    }
  }
  for (const [table, a] of Object.entries(before.workspaceKeyed)) {
    const b = after.workspaceKeyed[table];
    if (!b || a.count !== b.count) diffs.push(`${table} (workspace rows): ${a.count} -> ${b?.count ?? "unreadable"}`);
  }
  const key = (m) => `${m.invitee}`;
  const expected = before.members.filter((m) => !removedMembers.includes(m.invitee));
  for (const add of addedMembers) expected.push(add);
  expected.sort((a, b) => key(a).localeCompare(key(b)));
  const got = after.members.map((m) => ({ ...m }));
  if (!eq(expected, got)) diffs.push(`members: expected ${JSON.stringify(expected)} but found ${JSON.stringify(got)}`);
  if (!eq(before.numbers, after.numbers)) diffs.push("work numbers differ");
  if (!eq(before.emails, after.emails)) diffs.push("work emails differ");
  return diffs;
}

/** Every row of a table that should now belong to `userId`: returns "table: n rows still name someone else". */
export function ownerProblems(snap, userId, { moved = true } = {}) {
  const problems = [];
  const check = (label, histo) => {
    const others = Object.entries(histo ?? {}).filter(([id]) => id !== userId).reduce((n, [, c]) => n + c, 0);
    if (others > 0) problems.push(`${label}: ${others} row(s) do not belong to ${userId}`);
  };
  check("manager_property_records", snap.houseOwners);
  check("manager_sms_numbers", snap.numberOwners);
  check("manager_assistant_emails", snap.emailOwners);
  if (snap.workspace && snap.workspace.owner_user_id !== userId) problems.push("portal_workspaces: owner is someone else");
  if (moved) for (const [label, e] of Object.entries(snap.tables)) if (e.moved) check(label, e.byOwner);
  return problems;
}

/** Rows the RPC leaves naming the old owner, for the report: [{table, rows}]. */
export function leftBehind(snap, ownerId) {
  const out = [];
  for (const [label, e] of Object.entries(snap.tables)) {
    if (e.moved) continue;
    const n = e.byOwner[ownerId] ?? 0;
    if (n > 0) out.push({ table: label, rows: n, kind: "house" });
  }
  return out;
}

/** The workspace-keyed history count (rows that stay on the workspace id), for the report. */
export function workspaceHistory(snap) {
  return Object.entries(snap.workspaceKeyed)
    .filter(([, e]) => e.count > 0)
    .map(([table, e]) => ({ table, rows: e.count }));
}

/** One printable summary per house for the dry run. */
export function houseSummaries(houses, snap) {
  const t = (label) => snap.tables[label];
  return houses.map((h) => {
    const lease = t("portal_lease_pipeline_records")?.perHouse?.[h.id] ?? { total: 0, open: 0, residents: 0 };
    const charge = t("portal_household_charge_records")?.perHouse?.[h.id] ?? { total: 0, open: 0 };
    const sched = t("portal_schedule_records")?.perHouse?.[h.id] ?? { bookings: 0, upcoming: 0 };
    const per = (label) => t(label)?.byHouse?.[h.id] ?? 0;
    return {
      id: h.id,
      address: h.label,
      status: h.status ?? null,
      workspace: h.workspace_id,
      residents: lease.residents,
      leases: lease.total,
      openLeases: lease.open,
      bookings: sched.bookings,
      upcomingBookings: sched.upcoming,
      charges: charge.total,
      openCharges: charge.open,
      services: per("portal_work_order_records") + per("portal_service_request_records"),
      applications: per("manager_application_records") + per("manager_application_records#assigned"),
      conversations: per("manager_sms_conversation_houses"),
    };
  });
}
