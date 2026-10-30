/** Read-only, exact-ID DEV catalog preflight. No provider calls or writes. */
import { isAbsolute } from "node:path";
import catalog from "../e2e/support/draft-fk-catalog.json";
type Input = { authId: string; workspaceId: string; smsId: string; smsMissing: boolean; workspaceMissing: boolean };
type Db = { query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
const ident = (name: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("Unsupported catalog identifier."); return `"${name}"`; };
export async function preflightSyntheticWorkspace(db: Db, input: Input): Promise<void> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (![input.authId, input.workspaceId, input.smsId].every((value) => uuid.test(value))) throw new Error("Invalid synthetic identity.");
  const roots = await db.query("select id,owner_user_id::text,is_default,is_service from public.portal_workspaces where id=$1", [input.workspaceId]);
  if (input.workspaceMissing ? roots.rows.length !== 0 || !input.smsMissing : roots.rows.length !== 1 || roots.rows[0]?.owner_user_id !== input.authId || roots.rows[0]?.is_default !== true || roots.rows[0]?.is_service !== false) throw new Error("Synthetic workspace changed.");
  const actual = await db.query(`select c.conname, child.relname child_table, parent.relname parent_table, pg_get_constraintdef(c.oid) definition, c.confdeltype from pg_constraint c join pg_class child on child.oid=c.conrelid join pg_namespace ns on ns.oid=child.relnamespace join pg_class parent on parent.oid=c.confrelid join pg_namespace pn on pn.oid=parent.relnamespace where c.contype='f' and ns.nspname='public' and pn.nspname='public' and parent.relname=any($1::text[])`, [["portal_workspaces", "manager_property_records"]]);
  const key = (r: Record<string, unknown>) => [r.parent_table,r.child_table,r.conname,r.definition,r.confdeltype].join("|");
  if (JSON.stringify(actual.rows.map(key).sort()) !== JSON.stringify(catalog.rows.map(key).sort())) throw new Error("Workspace FK catalog changed.");
  for (const row of actual.rows.filter((r) => r.parent_table === "portal_workspaces")) {
    const match = /^FOREIGN KEY \(([a-z_][a-z0-9_]*)\) REFERENCES [a-z_][a-z0-9_]*\(id\)/.exec(String(row.definition));
    if (!match || typeof row.child_table !== "string") throw new Error("Unsupported workspace FK.");
    const count = await db.query(`select count(*)::int count from public.${ident(row.child_table)} where ${ident(match[1])}=$1`, [input.workspaceId]);
    const expected = row.child_table === "manager_sms_numbers" && match[1] === "workspace_id" && !input.smsMissing ? 1 : 0;
    if (Number(count.rows[0]?.count) !== expected) throw new Error(`Unexpected workspace descendant: ${row.child_table}`);
  }
  const columns = await db.query(`select c.table_name,c.column_name from information_schema.columns c join information_schema.tables t using(table_catalog,table_schema,table_name) where c.table_schema='public' and t.table_type='BASE TABLE' and c.column_name='workspace_id'`);
  for (const row of columns.rows) {
    if (typeof row.table_name !== "string") throw new Error("Unsupported workspace reference.");
    const count = await db.query(`select count(*)::int count from public.${ident(row.table_name)} where workspace_id::text=$1`, [input.workspaceId]);
    if (Number(count.rows[0]?.count) !== (row.table_name === "manager_sms_numbers" && !input.smsMissing ? 1 : 0)) throw new Error(`Unexpected workspace reference: ${row.table_name}`);
  }
  const sms = await db.query("select id::text,manager_user_id::text,workspace_id::text from public.manager_sms_numbers where id=$1", [input.smsId]);
  if (input.smsMissing ? sms.rows.length !== 0 : sms.rows.length !== 1 || sms.rows[0]?.manager_user_id !== input.authId || sms.rows[0]?.workspace_id !== input.workspaceId) throw new Error("Synthetic SMS identity changed.");
}
export async function preflightSyntheticWorkspaceOnDev(input: Input): Promise<void> {
  if (!process.env.SUPABASE_DB_SSL_CA_FILE || !isAbsolute(process.env.SUPABASE_DB_SSL_CA_FILE)) throw new Error("Verified DEV CA is required.");
  const modulePath = "../../scripts/security/nonproduction-database.mjs";
  const { nonproductionDatabaseConfig, connectNonproductionDatabase } = await import(/* @vite-ignore */ modulePath);
  const client = await connectNonproductionDatabase(nonproductionDatabaseConfig("emstjswhotsnyksqhqyf"));
  try { await client.query("BEGIN READ ONLY"); await client.query("SET LOCAL ROLE postgres"); await preflightSyntheticWorkspace(client, input); await client.query("ROLLBACK"); } finally { await client.end(); }
}
