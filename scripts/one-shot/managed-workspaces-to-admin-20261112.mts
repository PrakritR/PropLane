/**
 * ONE SHOT, captain waiver 2026-11-12 (.cursor/rules/no-production-live-listings.mdc): "if it is managed by PropLane it is
 * admin's workspace with the client as property owner". Moves the two PropLane-managed workspaces that are still owned by their
 * clients ("1. Ambika", "2. Vinod") to the PropLane service owner, through the ONE mover:
 * SQL `move_managed_workspace_to_service_owner` (supabase/migrations/20261112230000_managed_workspace_mover.sql).
 *
 *   npx tsx --conditions=react-server --env-file=<env> scripts/one-shot/managed-workspaces-to-admin-20261112.mts \
 *       --project-ref <ref> [--confirm-ref <ref>] [--accept-service-owner-email <email>]
 *       DRY RUN (default): resolves the service owner, lists the workspaces, houses, per-table counts (MOVE / ACCOUNT / KEEP),
 *       seats before and after, numbers, fee policy, owner payable, the payee, JSON copies of the old id, and every STOP reason.
 *       Writes nothing to the database. The output is saved beside the backups.
 *   ... --backup
 *       full-row JSON of every row the move can touch (a superset of the dry run's counts) plus the workspace, houses,
 *       seats, numbers and profile line caches; a SHA-256 of each file in a 0600 journal.
 *   ... --apply --expect-houses <n> --expect-workspaces <n> --backup-journal <file> --reason "<text>"
 *       Vinod first (empty: proves the path), then Ambika; one function call (one transaction) each; a read-back after each.
 *       Refuses without a backup newer than the latest dry run (and under 2 hours old). A second --apply says "already moved".
 *   ... --undo <journal>
 *       valid only inside the move's 2-hour read-back window (the SQL refuses afterwards): restores exactly the recorded rows.
 *
 * Production needs --confirm-ref <ref> even for the dry run; a write on production also needs --reason. Never run by an agent
 * with --apply on production: the captain approves the dry-run counts first.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveManagedPayee } from "../../src/lib/managed-finance/payee.server";

const REFS = { dev: "emstjswhotsnyksqhqyf", staging: "xwszcafaontidfgznlxd", production: "qahnczmilgptcedaqype" } as const;
const PRIMARY_ADMIN_EMAIL = "founders@axis-seattle-housing.com"; // src/lib/auth/primary-admin.ts
const UNDO_WINDOW_MINUTES = 120;
const BACKUP_MAX_AGE_MINUTES = 120;
const IDENT_COLS = ["manager_user_id", "owner_user_id", "owner_manager_user_id", "landlord_id"];

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Row = Record<string, Json>;
type Class = { table_name: string; klass: "move" | "account" | "keep" | "special"; id_col: string };

class Stop extends Error {}
function fail(message: string): never {
  console.error(`\none-shot FAILED: ${message}`);
  process.exit(1);
}
const argValue = (argv: string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const missing = (e: { code?: string } | null) => Boolean(e && ["42P01", "42703", "PGRST204", "PGRST205"].includes(String(e.code)));

async function fetchAll(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) {
      if (missing(error)) return [];
      throw new Error(error.message);
    }
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

type Ctx = {
  db: SupabaseClient;
  ref: string;
  target: "dev" | "staging" | "production";
  to: string;
  toEmail: string;
  classes: Class[];
  dir: string;
  log: (line: string) => void;
  preview?: boolean;
  readOnlySql?: (sql: string) => Row[];
};

async function hasColumn(db: SupabaseClient, table: string, column: string): Promise<boolean> {
  const { error } = await db.from(table).select(column).limit(1);
  return !error;
}

/** Rows of `cls.table_name` still naming `from` inside the workspace's scope (houses / workspace). Residual null-scope rows excluded. */
async function inScopeRows(ctx: Ctx, cls: Class, from: string, ws: string, houseIds: string[], select = "*"): Promise<Row[]> {
  const parts: string[] = [];
  if (houseIds.length && (await hasColumn(ctx.db, cls.table_name, "property_id"))) parts.push(`property_id.in.(${houseIds.map((h) => `"${h}"`).join(",")})`);
  if (houseIds.length && (await hasColumn(ctx.db, cls.table_name, "assigned_property_id"))) parts.push(`assigned_property_id.in.(${houseIds.map((h) => `"${h}"`).join(",")})`);
  if (await hasColumn(ctx.db, cls.table_name, "workspace_id")) parts.push(`workspace_id.eq.${ws}`);
  if (parts.length === 0) return [];
  return fetchAll((a, b) => ctx.db.from(cls.table_name).select(select).eq(cls.id_col, from).or(parts.join(",")).range(a, b));
}

async function allRowsOf(ctx: Ctx, cls: Class, from: string, select = "*"): Promise<Row[]> {
  return fetchAll((a, b) => ctx.db.from(cls.table_name).select(select).eq(cls.id_col, from).range(a, b));
}

async function pkOf(ctx: Ctx, table: string): Promise<string[]> {
  const { data } = await ctx.db.rpc("managed_move_pk_columns", { p_table: table });
  return Array.isArray(data) ? (data as string[]) : [];
}


function classesFromMigration(): Class[] {
  const file = path.join(process.cwd(), "supabase/migrations/20261112230000_managed_workspace_mover.sql");
  const sql = fs.readFileSync(file, "utf8");
  const body = sql.slice(sql.indexOf("select * from (values"), sql.indexOf(") as t(table_name, klass, id_col)"));
  return [...body.matchAll(/\('([a-z_]+)',\s*'(move|account|keep|special)',\s*'([a-z_]+)'\)/g)].map((m) => ({ table_name: m[1]!, klass: m[2] as Class["klass"], id_col: m[3]! }));
}

/** Read-only SQL against the target project through the Supabase CLI (management API). SELECT only; refuses anything else. */
function makeReadOnlySql(ref: string): (sql: string) => Row[] {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "managed-move-wd-"));
  fs.mkdirSync(path.join(wd, "supabase/.temp"), { recursive: true });
  fs.writeFileSync(path.join(wd, "supabase/.temp/project-ref"), ref);
  return (sql: string) => {
    if (!/^\s*select\b/i.test(sql) || /;\s*\S/.test(sql.trim().replace(/;\s*$/, ""))) throw new Error("read-only SQL must be one SELECT");
    const r = spawnSync("supabase", ["db", "query", "--linked", "--workdir", wd, "-o", "json", sql], { encoding: "utf8", env: process.env });
    const out = r.stdout ?? "";
    const i = out.indexOf("{");
    if (r.status !== 0 || i < 0) throw new Error(`read-only query failed: ${(r.stderr || out).slice(0, 300)}`);
    return (JSON.parse(out.slice(i)) as { rows?: Row[] }).rows ?? [];
  };
}

async function countRows(ctx: Ctx, table: string, apply: (q: any) => any): Promise<number> { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!(await tableExists(ctx.db, table))) return 0;
  const { count, error } = await apply(ctx.db.from(table).select("*", { count: "exact", head: true }));
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
}
const existsCache = new Map<string, boolean>();
async function tableExists(db: SupabaseClient, table: string): Promise<boolean> {
  if (!existsCache.has(table)) existsCache.set(table, !(await db.from(table).select("*", { head: true, count: "exact" }).limit(1)).error);
  return existsCache.get(table)!;
}

/** The mover's dry run, recomputed read-only (production before the migration is applied). Same output shape as the SQL. */
async function previewPlan(ctx: Ctx, w: { id: string; name: string; owner_user_id: string }, houseIds: string[]): Promise<Record<string, unknown>> {
  const { db } = ctx;
  const from = w.owner_user_id;
  const stops: string[] = [];
  const ws = (await db.from("portal_workspaces").select("is_service, owner_user_id").eq("id", w.id).maybeSingle()).data as { is_service: boolean } | null;
  if (!ws?.is_service) stops.push("workspace_not_service");
  if (from === ctx.to) stops.push("from_equals_service_owner");
  const roles = await db.from("profile_roles").select("role").eq("user_id", ctx.to);
  if (!((roles.data ?? []) as { role: string }[]).some((r) => r.role === "admin")) stops.push("service_owner_lacks_admin_role");
  const wrongHouse = await countRows(ctx, "manager_property_records", (q) => q.eq("workspace_id", w.id).neq("manager_user_id", from));
  if (wrongHouse) stops.push("house_not_owned_by_expected_from");
  const otherLive = await countRows(ctx, "portal_workspaces", (q) => q.eq("owner_user_id", from).neq("id", w.id).is("archived_at", null));
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const openCheckouts = await countRows(ctx, "resident_checkout_attempts", (q) => q.eq("manager_user_id", from).in("status", ["pending", "processing"]).gt("created_at", since));
  const stalePending = await countRows(ctx, "resident_checkout_attempts", (q) => q.eq("manager_user_id", from).in("status", ["pending", "processing"]).lte("created_at", since));
  const pendingWithdrawals = await countRows(ctx, "party_withdrawals", (q) => q.eq("workspace_id", w.id).in("status", ["reserved", "unknown"]));
  if (openCheckouts) stops.push(`open_checkout_attempts:${openCheckouts}`);
  if (pendingWithdrawals) stops.push(`pending_withdrawals:${pendingWithdrawals}`);
  const otherOfr = await countRows(ctx, "account_link_invites", (q) => q.eq("workspace_id", w.id).eq("is_owner_of_record", true).in("status", ["accepted", "pending"]).neq("invitee_user_id", from));
  if (otherOfr) stops.push("another_owner_of_record_seated");
  const nonOwnerSeat = await countRows(ctx, "account_link_invites", (q) => q.eq("workspace_id", w.id).eq("invitee_user_id", from).in("status", ["accepted", "pending"]).neq("team_role", "property_owner"));
  if (nonOwnerSeat) stops.push("client_holds_a_non_owner_seat");
  const clientSeat = await countRows(ctx, "account_link_invites", (q) => q.eq("workspace_id", w.id).eq("invitee_user_id", from).in("status", ["accepted", "pending"]).eq("team_role", "property_owner"));
  const ownSeat = await countRows(ctx, "account_link_invites", (q) => q.eq("workspace_id", w.id).eq("inviter_user_id", from).eq("invitee_user_id", ctx.to));

  // unclassified tables holding rows for the client (information_schema is not reachable over PostgREST: read-only SQL)
  const known = new Set(ctx.classes.map((c) => c.table_name));
  const unclassified: Record<string, number> = {};
  const ro = ctx.readOnlySql!;
  const idRows = ro(`select c.table_name, c.column_name from information_schema.columns c join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE' where c.table_schema='public' and c.column_name in ('manager_user_id','owner_user_id','owner_manager_user_id','landlord_id')`);
  for (const r of idRows) {
    const t = String(r.table_name);
    if (known.has(t)) continue;
    const n = await countRows(ctx, t, (q) => q.eq(String(r.column_name), from));
    if (n > 0) { unclassified[t] = n; stops.push(`unclassified_table:${t}:${n}`); }
  }

  const move: Record<string, number> = {}, account: Record<string, number> = {}, keep: Record<string, number> = {}, left: Record<string, number> = {};
  const hid = houseIds.map((h) => `"${h}"`).join(",");
  let scanned = 0;
  for (const cls of ctx.classes.filter((c) => c.klass === "move" || c.klass === "account" || c.klass === "keep")) {
    if (!(await tableExists(db, cls.table_name))) continue;
    scanned += 1;
    if (cls.klass === "move") {
      const parts: string[] = []; const nulls: string[] = [];
      if (await hasColumn(db, cls.table_name, "property_id")) { if (hid) parts.push(`property_id.in.(${hid})`); nulls.push("property_id.is.null"); }
      if (await hasColumn(db, cls.table_name, "assigned_property_id") && hid) parts.push(`assigned_property_id.in.(${hid})`);
      if (await hasColumn(db, cls.table_name, "workspace_id")) { parts.push(`workspace_id.eq.${w.id}`); nulls.push("workspace_id.is.null"); }
      if (otherLive === 0 && nulls.length) parts.push(`and(${nulls.join(",")})`);
      const n = parts.length ? await countRows(ctx, cls.table_name, (q) => q.eq(cls.id_col, from).or(parts.join(","))) : 0;
      const total = await countRows(ctx, cls.table_name, (q) => q.eq(cls.id_col, from));
      if (n) move[cls.table_name] = n;
      if (total - n > 0) left[cls.table_name] = total - n;
    } else {
      const n = await countRows(ctx, cls.table_name, (q) => q.eq(cls.id_col, from));
      if (n) {
        if (cls.klass === "account") { account[cls.table_name] = n; if (otherLive > 0) stops.push(`account_level_rows_with_another_live_workspace:${cls.table_name}`); }
        else keep[cls.table_name] = n;
      }
    }
  }
  return {
    status: "preview (mover not installed; read-only)", workspace: w.id, from, to: ctx.to, houseCount: houseIds.length, otherLiveWorkspacesOfClient: otherLive,
    move, account, keep, leftBehind: left, unclassified, tablesScanned: scanned, openCheckouts, stalePendingCheckouts: stalePending,
    pendingWithdrawals, clientSeatExists: clientSeat > 0, serviceOwnerOwnSeat: ownSeat > 0, stops,
  };
}

type Plan = {
  workspace: { id: string; name: string; owner_user_id: string; is_default: boolean };
  from: string;
  fromEmail: string;
  houses: { id: string; address: string; manager_user_id: string }[];
  dry: Record<string, unknown>;
  seats: Row[];
  policy: { id: string; owner_user_id: string; status: string } | null;
  payable: Json;
  payee: string | null;
  numbers: Row[];
  emails: Row[];
  jsonMentions: Record<string, number>;
};

async function planFor(ctx: Ctx, w: { id: string; name: string; owner_user_id: string; is_default: boolean }): Promise<Plan> {
  const { db } = ctx;
  const from = w.owner_user_id;
  const houseRows = await fetchAll((a, b) => db.from("manager_property_records").select("id, manager_user_id, property_data").eq("workspace_id", w.id).range(a, b));
  const houses = houseRows.map((h) => ({ id: String(h.id), manager_user_id: String(h.manager_user_id), address: String((h.property_data as Record<string, Json> | null)?.address ?? (h.property_data as Record<string, Json> | null)?.title ?? "") }));
  let dryData: Record<string, unknown>;
  if (ctx.preview) {
    dryData = await previewPlan(ctx, w, houses.map((h) => h.id));
  } else {
    const rpc = await db.rpc("move_managed_workspace_to_service_owner", { p_workspace: w.id, p_expected_from: from, p_dry_run: true });
    if (rpc.error) throw new Error(`dry run of the mover failed for ${w.name}: ${rpc.error.message}`);
    dryData = rpc.data as Record<string, unknown>;
  }
  const seats = await fetchAll((a, b) => db.from("account_link_invites").select("*").eq("workspace_id", w.id).range(a, b));
  const pol = await db.from("managed_workspace_fee_policies").select("id, owner_user_id, status").eq("workspace_id", w.id).eq("status", "active").maybeSingle();
  const payable = await db.rpc("party_balance", { p_account: "owner_payable", p_party: `owner:${from}`, p_workspace: w.id });
  const numbers = await fetchAll((a, b) => db.from("manager_sms_numbers").select("*").eq("workspace_id", w.id).range(a, b));
  const emails = await fetchAll((a, b) => db.from("manager_assistant_emails").select("*").eq("workspace_id", w.id).range(a, b));
  const fromProfile = await db.auth.admin.getUserById(from);
  // JSON copies of the old id (report only: not rewritten under this waiver)
  const jsonMentions: Record<string, number> = {};
  for (const t of ["manager_application_records", "portal_lease_pipeline_records", "portal_household_charge_records"]) {
    const cls = ctx.classes.find((c) => c.table_name === t);
    if (!cls) continue;
    const rows = await inScopeRows(ctx, cls, from, w.id, houses.map((h) => h.id), "row_data").catch(() => []);
    const n = rows.filter((r) => canon(r.row_data).includes(from)).length;
    if (n) jsonMentions[t] = n;
  }
  const hn = houseRows.filter((h) => canon(h.property_data).includes(from)).length;
  if (hn) jsonMentions.manager_property_records = hn;
  return {
    workspace: w, from, fromEmail: fromProfile.data.user?.email ?? "?", houses, dry: dryData, seats,
    policy: (pol.data as Plan["policy"]) ?? null, payable: (payable.data ?? null) as Json, payee: await resolveManagedPayee(db, w.id), numbers, emails, jsonMentions,
  };
}

function printPlan(ctx: Ctx, p: Plan) {
  const d = p.dry as { move?: object; account?: object; keep?: object; leftBehind?: object; stops?: string[]; otherLiveWorkspacesOfClient?: number; tablesScanned?: number; openCheckouts?: number; stalePendingCheckouts?: number; pendingWithdrawals?: number; clientSeatExists?: boolean; serviceOwnerOwnSeat?: boolean; status?: string };
  const l = ctx.log;
  l(`\n=== ${p.workspace.name}  (${p.workspace.id}) ===`);
  l(`from ${p.from} (${p.fromEmail})  ->  to ${ctx.to} (${ctx.toEmail})   mover status: ${d.status}`);
  l(`houses (${p.houses.length}):`);
  for (const h of p.houses) l(`  ${h.id}  ${h.address}  owner=${h.manager_user_id === p.from ? "client" : h.manager_user_id}`);
  l(`client's other live workspaces: ${d.otherLiveWorkspacesOfClient}   tables scanned: ${d.tablesScanned}`);
  l(`MOVE (rows that change owner):    ${JSON.stringify(d.move)}`);
  l(`ACCOUNT-LEVEL (moves, sole ws):   ${JSON.stringify(d.account)}`);
  l(`KEEP (never written):             ${JSON.stringify(d.keep)}`);
  l(`left behind (scoped tables, rows of the client outside this workspace): ${JSON.stringify(d.leftBehind)}`);
  l(`seats before (${p.seats.length}): ${p.seats.map((s) => `${String(s.team_role)}:${String(s.status)}${s.is_owner_of_record ? ":ofr" : ""}${s.is_service_seat ? ":svc" : ""} inviter=${String(s.inviter_user_id).slice(0, 8)} invitee=${String(s.invitee_user_id).slice(0, 8)}`).join(" | ") || "none"}`);
  l(`seats after: service owner's own seat removed=${d.serviceOwnerOwnSeat ? "yes" : "n/a"}; every live seat answers to the service owner; client seated as property_owner + owner of record (exists already: ${d.clientSeatExists ? "yes" : "no, will be inserted"})`);
  l(`work numbers: ${p.numbers.map((n) => `${String(n.phone_number)}${n.released_at ? "(released)" : ""}`).join(", ") || "none"}   work emails: ${p.emails.map((e) => String(e.mailbox_local ?? e.address ?? e.id)).join(", ") || "none"}`);
  l(`active fee policy: ${p.policy ? `${p.policy.id} owner=${p.policy.owner_user_id}` : "NONE"}   owner payable (owner:${p.from.slice(0, 8)}): ${JSON.stringify(p.payable)}`);
  l(`payee (resolveManagedPayee) before: ${p.payee ?? "null"}   predicted after: ${p.from}`);
  l(`JSON copies of the old id (report only, never rewritten): ${JSON.stringify(p.jsonMentions)}`);
  l(`open checkouts (24h): ${d.openCheckouts}   stale pending checkouts: ${d.stalePendingCheckouts}   pending withdrawals: ${d.pendingWithdrawals}`);
  l(`STOPS: ${d.stops && d.stops.length ? d.stops.join("; ") : "none"}`);
}

async function resolveWorld(db: SupabaseClient, ref: string, target: Ctx["target"], acceptEmail: string | undefined, dir: string, log: Ctx["log"]) {
  const settings = await db.from("platform_service_settings").select("owner_user_id").eq("singleton", true).maybeSingle();
  if (settings.error || !settings.data) throw new Stop("platform_service_settings is unreadable or empty");
  const to = String((settings.data as { owner_user_id: string }).owner_user_id);
  const auth = await db.auth.admin.getUserById(to);
  const email = String(auth.data.user?.email ?? "").trim().toLowerCase();
  const confirmed = Boolean(auth.data.user?.email_confirmed_at);
  const roles = await db.from("profile_roles").select("role").eq("user_id", to);
  const isAdmin = ((roles.data ?? []) as { role: string }[]).some((r) => r.role === "admin");
  if (!isAdmin) throw new Stop(`service owner ${to} does not hold the admin role`);
  if (!confirmed) throw new Stop(`service owner ${to} has an unconfirmed email`);
  const isPrimary = email === PRIMARY_ADMIN_EMAIL;
  const accepted = acceptEmail && acceptEmail.trim().toLowerCase() === email;
  if (!isPrimary && !accepted) {
    throw new Stop(`service owner is ${email}, which is not the primary admin (${PRIMARY_ADMIN_EMAIL}). If this is the account the captain runs the service from, pass --accept-service-owner-email ${email} (D1). Nothing was changed.`);
  }
  if (!isPrimary && target !== "production") log(`note: service owner ${email} accepted by --accept-service-owner-email (not the primary-admin email)`);
  if (!isPrimary && target === "production") log(`NOTE: production service owner ${email} is accepted explicitly via --accept-service-owner-email; the primary-admin constant is ${PRIMARY_ADMIN_EMAIL}`);
  const cl = await db.rpc("managed_move_classification");
  const forced = process.env.MANAGED_MOVE_FORCE_PREVIEW === "1" && target === "dev"; // rehearsal: compare the preview planner with the SQL dry run
  if (cl.error || forced) {
    // The mover migration has not been applied here (production, before the captain's go). A DRY RUN still works: the
    // classification is read from the migration file and the plan is computed read-only (`previewPlan`). --apply never does.
    if (target === "dev" && !forced) throw new Stop(`the mover is not installed on dev: ${cl.error?.message}`);
    log(`NOTE: the mover is ${forced ? "bypassed (MANAGED_MOVE_FORCE_PREVIEW)" : "NOT installed"} on ${target} (${cl.error?.message ?? "forced"}). Counts below come from the script's read-only preview planner, using the classification in the migration file.`);
    return { to, email, classes: classesFromMigration(), dir, ref, target, preview: true };
  }
  return { to, email, classes: cl.data as Class[], dir, ref, target, preview: false };
}

async function listTargets(db: SupabaseClient, to: string) {
  const ws = await fetchAll((a, b) => db.from("portal_workspaces").select("id, name, owner_user_id, is_default, is_service, archived_at").eq("is_service", true).neq("owner_user_id", to).is("archived_at", null).range(a, b));
  return ws.map((w) => ({ id: String(w.id), name: String(w.name), owner_user_id: String(w.owner_user_id), is_default: Boolean(w.is_default) })).sort((x, y) => x.name.localeCompare(y.name));
}

function stampNow() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
  const argv = process.argv.slice(2);
  const projectRef = argValue(argv, "--project-ref");
  const confirmRef = argValue(argv, "--confirm-ref");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const urlRef = (() => { try { return new URL(url).hostname.split(".")[0] ?? ""; } catch { return ""; } })();
  if (!projectRef) fail("--project-ref is required");
  if (urlRef !== projectRef) fail(`--project-ref ${projectRef} does not match the Supabase URL ref (${urlRef || "none"})`);
  const target = (Object.entries(REFS).find(([, v]) => v === projectRef)?.[0] ?? null) as Ctx["target"] | null;
  if (!target) fail(`unknown project ${projectRef}`);
  if (target !== "dev" && confirmRef !== projectRef) fail(`${target} needs --confirm-ref ${projectRef} even for the dry run`);
  if (!key) fail("SUPABASE_SERVICE_ROLE_KEY is not set");
  const apply = argv.includes("--apply");
  const doBackup = argv.includes("--backup");
  const undoFile = argValue(argv, "--undo");
  const writes = apply || Boolean(undoFile);
  const reason = (argValue(argv, "--reason") ?? "").trim();
  if (writes && target !== "dev" && reason.length < 10) fail(`--reason "<text>" (10+ characters) is required to write to ${target}`);
  if (apply && undoFile) fail("--apply and --undo are separate runs");

  const dir = path.join(os.homedir(), ".cockpit/backups/managed-move-1112", projectRef);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = createClient(url, key, { auth: { persistSession: false } });
  const lines: string[] = [];
  const log = (line: string) => { lines.push(line); console.log(line); };
  const acceptEmail = argValue(argv, "--accept-service-owner-email");

  try {
    const world = await resolveWorld(db, projectRef, target, acceptEmail, dir, log);
    const ctx: Ctx = { db, ref: projectRef, target, to: world.to, toEmail: world.email, classes: world.classes, dir, log, preview: world.preview, readOnlySql: world.preview ? makeReadOnlySql(projectRef) : undefined };
    if (world.preview && (apply || undoFile || doBackup)) throw new Stop("the mover migration is not installed here, so --apply, --backup and --undo are refused (dry run only)");
    log(`${apply ? "APPLY" : undoFile ? "UNDO" : doBackup ? "BACKUP" : "DRY RUN"}  project=${projectRef} (${target})  at ${new Date().toISOString()}`);
    log(`service owner: ${world.to} (${world.email}), admin role: yes, email confirmed: yes`);

    if (undoFile) return await runUndo(ctx, undoFile);

    const targets = await listTargets(db, world.to);
    log(`PropLane-managed workspaces not owned by the service owner: ${targets.length}`);
    for (const t of targets) log(`  - ${t.name} (${t.id})`);
    if (apply) {
      // Single-apply: workspaces the mover already recorded as moved (live move row, or this script's own marker) are done.
      const moved = await fetchAll((a, b) => db.from("managed_workspace_ownership_moves").select("workspace_id, moved_at").is("undone_at", null).range(a, b));
      const movedIds = new Set(moved.map((m) => String(m.workspace_id)));
      const wanted = target === "production" ? null : new Set((argValue(argv, "--workspace") ?? "").split(",").filter(Boolean));
      const remaining = wanted ? targets.filter((t) => wanted.has(t.id)) : targets;
      const allDone = remaining.length === 0 && (wanted ? [...wanted].every((id) => movedIds.has(id)) : movedIds.size >= 2);
      if (allDone) {
        log(`already moved: ${wanted ? [...wanted].join(", ") : [...movedIds].join(", ")} (single-apply marker in managed_workspace_ownership_moves). Nothing to do.`);
        return;
      }
    }
    const expectWorkspaces = Number(argValue(argv, "--expect-workspaces") ?? (target === "production" ? 2 : NaN));
    if (target === "production") {
      const names = targets.map((t) => t.name.toLowerCase());
      if (targets.length !== 2 || !names.some((n) => n.includes("ambika")) || !names.some((n) => n.includes("vinod"))) {
        throw new Stop(`expected exactly "1. Ambika" and "2. Vinod" on production, found ${targets.length}: ${targets.map((t) => t.name).join(", ")}`);
      }
    } else {
      const only = argValue(argv, "--workspace");
      if (!only) throw new Stop("on dev/staging name the rehearsal workspace(s) with --workspace <id>[,<id>] (nothing else is touched)");
      const set = new Set(only.split(","));
      for (const t of [...targets]) if (!set.has(t.id)) targets.splice(targets.indexOf(t), 1);
      if (targets.length !== set.size) throw new Stop(`--workspace names ${set.size} workspace(s) but ${targets.length} are client-owned managed workspaces`);
    }
    const ordered = [...targets].sort((a, b) => {
      return a.name.toLowerCase().includes("vinod") ? -1 : b.name.toLowerCase().includes("vinod") ? 1 : a.name.localeCompare(b.name);
    });

    const plans: Plan[] = [];
    for (const t of ordered) {
      const p = await planFor(ctx, t);
      plans.push(p);
      printPlan(ctx, p);
    }
    const stops = plans.flatMap((p) => ((p.dry as { stops?: string[] }).stops ?? []).map((s) => `${p.workspace.name}: ${s}`));
    const houseTotal = plans.reduce((n, p) => n + p.houses.length, 0);
    log(`\nTOTAL: ${plans.length} workspaces, ${houseTotal} houses, ${stops.length} stop(s)`);

    if (!apply && !doBackup) {
      const f = path.join(dir, `dryrun-${stampNow()}.txt`);
      fs.writeFileSync(f, lines.join("\n") + "\n", { mode: 0o600 });
      console.log(`\ndry run saved: ${f}. Nothing was written to the database.`);
      return;
    }
    if (stops.length) throw new Stop(`stops present, nothing written: ${stops.join(" | ")}`);

    if (doBackup) {
      const dryRuns = fs.readdirSync(dir).filter((f) => f.startsWith("dryrun-")).sort();
      if (dryRuns.length === 0) throw new Stop("run the dry run first (and have the counts approved)");
      const stamp = stampNow();
      const bdir = path.join(dir, `backup-${stamp}`);
      fs.mkdirSync(bdir, { recursive: true, mode: 0o700 });
      const files: Record<string, string> = {};
      const writeFile = (name: string, data: unknown) => {
        const body = JSON.stringify(data, null, 1);
        const f = path.join(bdir, name);
        fs.writeFileSync(f, body, { mode: 0o600 });
        files[name] = sha(body);
      };
      const wsBackup: Record<string, unknown>[] = [];
      for (const p of plans) {
        const w = p.workspace.id;
        const meta = {
          workspace: (await db.from("portal_workspaces").select("*").eq("id", w).maybeSingle()).data,
          houses: await fetchAll((a, b) => db.from("manager_property_records").select("*").eq("workspace_id", w).range(a, b)),
          seats: p.seats, numbers: p.numbers, emails: p.emails,
          fromProfile: (await db.from("profiles").select("id, sms_from_number, email").eq("id", p.from).maybeSingle()).data,
          toProfile: (await db.from("profiles").select("id, sms_from_number, email").eq("id", world.to).maybeSingle()).data,
          policy: p.policy, payable: p.payable, payee: p.payee,
        };
        writeFile(`${w}.workspace.json`, meta);
        const counts: Record<string, number> = {};
        for (const cls of world.classes.filter((c) => c.klass === "move" || c.klass === "account")) {
          const rows = await allRowsOf(ctx, cls, p.from);
          if (rows.length) { writeFile(`${w}.${cls.table_name}.json`, rows); counts[cls.table_name] = rows.length; }
        }
        wsBackup.push({ workspaceId: w, name: p.workspace.name, from: p.from, houseIds: p.houses.map((h) => h.id), tableRowCounts: counts });
      }
      const journal = {
        kind: "managed-move-backup", ref: projectRef, createdAt: new Date().toISOString(), dryRunFile: dryRuns[dryRuns.length - 1],
        dryRunSha256: sha(fs.readFileSync(path.join(dir, dryRuns[dryRuns.length - 1]!))), serviceOwner: world.to, workspaces: wsBackup, files,
      };
      const jf = path.join(bdir, "journal.json");
      fs.writeFileSync(jf, JSON.stringify(journal, null, 2), { mode: 0o600 });
      console.log(`\nbackup written: ${jf}  (${Object.keys(files).length} files, each with a SHA-256 in the journal)`);
      return;
    }

    // ---------------------------------------------------------------- apply
    const journalFile = argValue(argv, "--backup-journal");
    if (!journalFile) throw new Stop("--backup-journal <file> is required (run --backup first)");
    const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as { kind: string; ref: string; createdAt: string; dryRunFile: string; files: Record<string, string>; workspaces: { workspaceId: string; from: string; houseIds: string[] }[] };
    if (journal.kind !== "managed-move-backup" || journal.ref !== projectRef) throw new Stop("that backup journal is not for this project");
    const age = (Date.now() - Date.parse(journal.createdAt)) / 60000;
    if (!(age >= 0 && age <= BACKUP_MAX_AGE_MINUTES)) throw new Stop(`the backup is ${Math.round(age)} minutes old (max ${BACKUP_MAX_AGE_MINUTES}); take a fresh one`);
    const latestDry = fs.readdirSync(dir).filter((f) => f.startsWith("dryrun-")).sort().pop();
    if (latestDry && latestDry > journal.dryRunFile) throw new Stop("a newer dry run exists than the one this backup was taken after; take a fresh backup");
    const bdir = path.dirname(journalFile);
    for (const [name, hash] of Object.entries(journal.files)) {
      if (sha(fs.readFileSync(path.join(bdir, name))) !== hash) throw new Stop(`backup file ${name} no longer matches its SHA-256`);
    }
    const expectHouses = Number(argValue(argv, "--expect-houses"));
    if (!Number.isFinite(expectHouses) || expectHouses !== houseTotal) throw new Stop(`--expect-houses ${argValue(argv, "--expect-houses")} does not match the ${houseTotal} houses found`);
    if (!Number.isFinite(expectWorkspaces) || expectWorkspaces !== plans.length) throw new Stop(`--expect-workspaces must equal the ${plans.length} workspaces found`);
    if (journal.workspaces.length !== plans.length) throw new Stop("the backup does not cover the same workspaces");

    let movedAny = false;
    for (const p of plans) {
      const marker = path.join(dir, `${p.workspace.id}.applied`);
      if (fs.existsSync(marker)) { log(`${p.workspace.name}: already moved (${marker}); skipping`); continue; }
      movedAny = true;
      log(`\n--- moving ${p.workspace.name} ---`);
      await snapshotKeep(ctx, p, bdir);
      const res = await db.rpc("move_managed_workspace_to_service_owner", { p_workspace: p.workspace.id, p_expected_from: p.from, p_dry_run: false });
      if (res.error) throw new Stop(`the mover refused ${p.workspace.name} (nothing written for it): ${res.error.message}`);
      log(`mover: ${JSON.stringify(res.data)}`);
      const problems = await readBack(ctx, p, bdir, journalFile);
      if (problems.length) {
        console.error(problems.map((x) => `  - ${x}`).join("\n"));
        const undoCmd = `npx tsx --conditions=react-server --env-file=<env> scripts/one-shot/managed-workspaces-to-admin-20261112.mts --project-ref ${projectRef}${target !== "dev" ? ` --confirm-ref ${projectRef}` : ""} --undo ${journalFile}${target !== "dev" ? ` --reason "<text>"` : ""}`;
        fail(`read-back of ${p.workspace.name} FAILED. Undo (valid for ${UNDO_WINDOW_MINUTES} minutes): ${undoCmd}`);
      }
      fs.writeFileSync(marker, `${new Date().toISOString()} ${journalFile}\n`, { mode: 0o600 });
      log(`${p.workspace.name}: read-back OK; marker ${marker}`);
    }
    if (!movedAny) log("\nalready moved: nothing to do.");
    const f = path.join(dir, `apply-${stampNow()}.txt`);
    fs.writeFileSync(f, lines.join("\n") + "\n", { mode: 0o600 });
    console.log(`\napply log saved: ${f}`);
  } catch (e) {
    if (e instanceof Stop) fail(e.message);
    throw e;
  }
}

/** The ids (primary keys) of every KEEP table row of the client, before the move: the read-back compares them after. */
async function snapshotKeep(ctx: Ctx, p: Plan, bdir: string) {
  const snap: Record<string, { n: number; hash: string }> = {};
  for (const cls of ctx.classes.filter((c) => c.klass === "keep")) {
    const pk = await pkOf(ctx, cls.table_name);
    if (pk.length === 0) continue;
    const rows = await allRowsOf(ctx, cls, p.from, pk.join(","));
    if (rows.length) snap[cls.table_name] = { n: rows.length, hash: sha(canon(rows.map((r) => canon(r)).sort())) };
  }
  const owned = await fetchAll((a, b) => ctx.db.from("manager_sms_numbers").select("id, workspace_id, phone_number").eq("manager_user_id", ctx.to).range(a, b));
  const extra = { keep: snap, serviceOwnerNumbers: owned.filter((n) => n.workspace_id !== p.workspace.id), payee: p.payee, policy: p.policy, payable: p.payable };
  fs.writeFileSync(path.join(bdir, `${p.workspace.id}.prestate.json`), JSON.stringify(extra, null, 1), { mode: 0o600 });
}

async function readBack(ctx: Ctx, p: Plan, bdir: string, _journalFile: string): Promise<string[]> {
  void _journalFile;
  const { db } = ctx;
  const w = p.workspace.id;
  const problems: string[] = [];
  const pre = JSON.parse(fs.readFileSync(path.join(bdir, `${w}.prestate.json`), "utf8")) as { keep: Record<string, { n: number; hash: string }>; serviceOwnerNumbers: Row[]; payee: string | null; policy: Plan["policy"]; payable: Json };
  const meta = JSON.parse(fs.readFileSync(path.join(bdir, `${w}.workspace.json`), "utf8")) as { houses: Row[] };

  const ws = (await db.from("portal_workspaces").select("owner_user_id").eq("id", w).maybeSingle()).data as { owner_user_id: string } | null;
  if (ws?.owner_user_id !== ctx.to) problems.push("workspace owner is not the service owner");
  const houses = await fetchAll((a, b) => db.from("manager_property_records").select("*").eq("workspace_id", w).range(a, b));
  const houseIds = houses.map((h) => String(h.id));
  for (const h of houses) if (h.manager_user_id !== ctx.to) problems.push(`house ${String(h.id)} still names ${String(h.manager_user_id)}`);
  // byte-identical listing content
  for (const before of meta.houses) {
    const after = houses.find((h) => h.id === before.id);
    if (!after) { problems.push(`house ${String(before.id)} vanished`); continue; }
    if (canon(after.property_data) !== canon(before.property_data)) problems.push(`property_data of ${String(before.id)} differs from the backup`);
    if (canon(after.row_data) !== canon(before.row_data)) problems.push(`row_data of ${String(before.id)} differs from the backup`);
    if (sha(canon(after.property_data)) !== sha(canon(before.property_data))) problems.push(`property_data hash of ${String(before.id)} differs`);
  }
  // zero in-scope MOVE rows still name the client
  for (const cls of ctx.classes.filter((c) => c.klass === "move")) {
    const rows = await inScopeRows(ctx, cls, p.from, w, houseIds, cls.id_col);
    if (rows.length) problems.push(`${rows.length} in-scope ${cls.table_name} row(s) still name the client`);
  }
  // KEEP rows untouched (counts and a hash of their primary keys)
  for (const cls of ctx.classes.filter((c) => c.klass === "keep")) {
    const was = pre.keep[cls.table_name];
    const pk = await pkOf(ctx, cls.table_name);
    const rows = pk.length ? await allRowsOf(ctx, cls, p.from, pk.join(",")) : [];
    const now = rows.length ? { n: rows.length, hash: sha(canon(rows.map((r) => canon(r)).sort())) } : undefined;
    if (canon(was) !== canon(now)) problems.push(`KEEP table ${cls.table_name} changed (${was?.n ?? 0} -> ${now?.n ?? 0} rows)`);
  }
  // seats: exactly one accepted property_owner + owner of record = the client
  const seats = await fetchAll((a, b) => db.from("account_link_invites").select("*").eq("workspace_id", w).range(a, b));
  const owners = seats.filter((s) => s.team_role === "property_owner" && s.status === "accepted" && s.is_owner_of_record === true);
  if (owners.length !== 1 || owners[0]!.invitee_user_id !== p.from) problems.push("the client is not the one accepted property_owner + owner of record seat");
  if (owners[0] && owners[0].inviter_user_id !== ctx.to) problems.push("the client's seat is not issued by the service owner");
  const live = seats.filter((s) => s.status === "pending" || s.status === "accepted");
  for (const s of live) if (s.inviter_user_id !== ctx.to) problems.push(`seat ${String(s.id)} still answers to ${String(s.inviter_user_id)}`);
  const staffBefore = p.seats.filter((s) => (s.status === "pending" || s.status === "accepted") && !(s.inviter_user_id === p.from && s.invitee_user_id === ctx.to) && s.team_role !== "property_owner").length;
  const staffAfter = live.filter((s) => s.team_role !== "property_owner").length;
  if (staffBefore !== staffAfter) problems.push(`staff seats ${staffBefore} -> ${staffAfter} (expected unchanged minus the service owner's own)`);
  if (seats.some((s) => s.invitee_user_id === ctx.to)) problems.push("the service owner still has an Admin seat in a workspace they own");
  // payee, policy, balance unchanged
  const payee = await resolveManagedPayee(db, w);
  if (payee !== p.from) problems.push(`resolveManagedPayee = ${payee ?? "null"}, expected the client`);
  const pol = (await db.from("managed_workspace_fee_policies").select("id, owner_user_id, status").eq("workspace_id", w).eq("status", "active").maybeSingle()).data;
  if (canon(pol ?? null) !== canon(pre.policy ?? null)) problems.push("the active fee policy changed");
  const bal = await db.rpc("party_balance", { p_account: "owner_payable", p_party: `owner:${p.from}`, p_workspace: w });
  if (canon(bal.data ?? null) !== canon(pre.payable ?? null)) problems.push("the owner payable balance changed");
  // numbers: moved numbers carry their workspace; the service owner's other numbers (the PropLane line) are untouched
  const nums = await fetchAll((a, b) => db.from("manager_sms_numbers").select("id, workspace_id, phone_number").eq("manager_user_id", ctx.to).range(a, b));
  if (nums.some((n) => n.workspace_id === null)) problems.push("a number owned by the service owner has a null workspace_id (the PropLane line could be mis-resolved)");
  const others = nums.filter((n) => n.workspace_id !== w);
  if (canon(others) !== canon(pre.serviceOwnerNumbers)) problems.push("the service owner's other numbers changed (the PropLane line)");
  return problems;
}

async function runUndo(ctx: Ctx, undoFile: string) {
  const { db } = ctx;
  const journal = JSON.parse(fs.readFileSync(undoFile, "utf8")) as { kind: string; ref: string; workspaces: { workspaceId: string; name: string; from: string; houseIds: string[] }[]; files: Record<string, string> };
  if (journal.kind !== "managed-move-backup" || journal.ref !== ctx.ref) fail("that journal is not for this project");
  const bdir = path.dirname(undoFile);
  for (const w of [...journal.workspaces].reverse()) {
    const res = await db.rpc("undo_managed_workspace_move", { p_workspace: w.workspaceId });
    if (res.error) fail(`undo of ${w.name} refused: ${res.error.message}`);
    ctx.log(`${w.name}: ${JSON.stringify(res.data)}`);
    const meta = JSON.parse(fs.readFileSync(path.join(bdir, `${w.workspaceId}.workspace.json`), "utf8")) as { houses: Row[]; workspace: Row };
    const ws = (await db.from("portal_workspaces").select("owner_user_id").eq("id", w.workspaceId).maybeSingle()).data as { owner_user_id: string } | null;
    const problems: string[] = [];
    if (ws?.owner_user_id !== w.from) problems.push("workspace owner not restored");
    for (const before of meta.houses) {
      const after = (await db.from("manager_property_records").select("*").eq("id", String(before.id)).maybeSingle()).data as Row | null;
      if (!after || after.manager_user_id !== w.from) problems.push(`house ${String(before.id)} not restored`);
      else if (canon(after.property_data) !== canon(before.property_data)) problems.push(`property_data of ${String(before.id)} differs`);
    }
    for (const cls of ctx.classes.filter((c) => c.klass === "move" || c.klass === "account")) {
      const f = path.join(bdir, `${w.workspaceId}.${cls.table_name}.json`);
      if (!fs.existsSync(f)) continue;
      const saved = JSON.parse(fs.readFileSync(f, "utf8")) as Row[];
      const pk = await pkOf(ctx, cls.table_name);
      const now = await allRowsOf(ctx, cls, w.from, pk.join(","));
      const have = new Set(now.map((r) => canon(r)));
      const lost = saved.filter((r) => !have.has(canon(Object.fromEntries(pk.map((k) => [k, r[k]])))));
      if (lost.length) problems.push(`${lost.length} ${cls.table_name} row(s) did not return to the client`);
    }
    if (problems.length) fail(`undo of ${w.name} did not verify:\n${problems.map((x) => `  - ${x}`).join("\n")}`);
    const marker = path.join(ctx.dir, `${w.workspaceId}.applied`);
    if (fs.existsSync(marker)) fs.renameSync(marker, `${marker}.undone-${stampNow()}`);
    ctx.log(`${w.name}: undone and verified (owner, houses byte-identical, every moved row back with the client)`);
  }
}

void main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
