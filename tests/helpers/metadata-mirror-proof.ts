/** Test-only split-B proof. The canonical account and workspace are read-only. */
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import catalog from "../e2e/support/draft-fk-catalog.json";

type Input = { managerId: string; workspaceId: string; propertyId: string; marker: string; updatedAt?: string; channelSnapshot?: string };
type Db = { query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
export type MetadataMirrorManifest = Input & { state: "reserved" | "saved" | "delete_started" | "cleaned" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validPropertyId(propertyId: string, marker: string): boolean {
  return uuid.test(propertyId) && /^metadata-proof-[a-f0-9-]{36}$/.test(marker);
}
const identifier = (value: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error("Unsupported catalog identifier."); return `"${value}"`; };
export function persistMetadataManifest(file: string, manifest: MetadataMirrorManifest): void {
  if (!path.isAbsolute(file) || (lstatSync(path.dirname(file)).mode & 0o777) !== 0o700 || !uuid.test(manifest.managerId) || !uuid.test(manifest.workspaceId) || !validPropertyId(manifest.propertyId, manifest.marker) || !/^metadata-proof-[a-f0-9-]{36}$/.test(manifest.marker)) throw new Error("Invalid private split-B manifest.");
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(manifest)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}
/** Run before and after save, and after the exact proof server has stopped. */
export async function preflightMetadata(db: Db, input: Input, expected: "absent" | "live"): Promise<void> {
  if (!uuid.test(input.managerId) || !uuid.test(input.workspaceId) || !validPropertyId(input.propertyId, input.marker) || !/^metadata-proof-[a-f0-9-]{36}$/.test(input.marker)) throw new Error("Invalid split-B identity.");
  const workspace = await db.query("select owner_user_id::text,is_service from public.portal_workspaces where id=$1", [input.workspaceId]);
  if (workspace.rows.length !== 1 || workspace.rows[0]?.owner_user_id !== input.managerId || workspace.rows[0]?.is_service !== false) throw new Error("Workspace ownership or eligibility changed.");
  const connection = await db.query("select count(*)::int count from public.listing_channel_connections where workspace_id=$1", [input.workspaceId]);
  if (connection.rows[0]?.count !== 0) throw new Error("Workspace has a listing-channel connection.");
  const existingPosts = await db.query(`select to_jsonb(p)::text snapshot, p.manager_user_id::text manager_user_id, p.property_id, p.channel, p.enabled, p.state, p.pending_action, p.external_id, p.content_hash, p.posted_at, p.next_attempt_at, p.attempts, exists(select 1 from public.manager_property_records r where r.id=p.property_id) property_exists from public.listing_channel_posts p where p.workspace_id=$1`, [input.workspaceId]);
  if (existingPosts.rows.length > 1) throw new Error("Unexpected workspace channel posts.");
  const existing = existingPosts.rows[0];
  if (existing && (existing.manager_user_id !== input.managerId || existing.property_id !== "demo-prop-fremont" || existing.channel !== "craigslist" || existing.enabled !== false || existing.state !== "off" || existing.pending_action !== null || existing.external_id !== null || existing.content_hash !== null || existing.posted_at !== null || existing.next_attempt_at !== null || existing.attempts !== 0 || existing.property_exists !== false || typeof existing.snapshot !== "string")) throw new Error("Unexpected workspace channel post state.");
  const snapshot = existing ? createHash("sha256").update(String(existing.snapshot)).digest("hex") : "none";
  if (input.channelSnapshot === undefined && expected === "absent") input.channelSnapshot = snapshot;
  else if (input.channelSnapshot !== snapshot) throw new Error("Existing channel post changed.");
  const property = await db.query("select status,manager_user_id::text,workspace_id::text,updated_at::text,row_data,property_data from public.manager_property_records where id=$1", [input.propertyId]);
  if (expected === "absent" ? property.rows.length !== 0 : property.rows.length !== 1 || property.rows[0]?.status !== "live" || property.rows[0]?.manager_user_id !== input.managerId || property.rows[0]?.workspace_id !== input.workspaceId || (input.updatedAt != null && Date.parse(String(property.rows[0]?.updated_at)) !== Date.parse(input.updatedAt)) || !JSON.stringify([property.rows[0]?.row_data, property.rows[0]?.property_data]).includes(input.marker)) throw new Error("Draft ownership or state changed.");
  const constraints = await db.query(`select c.conname,child.relname child_table,parent.relname parent_table,pg_get_constraintdef(c.oid) definition,c.confdeltype from pg_constraint c join pg_class child on child.oid=c.conrelid join pg_namespace ns on ns.oid=child.relnamespace join pg_class parent on parent.oid=c.confrelid join pg_namespace pn on pn.oid=parent.relnamespace where c.contype='f' and ns.nspname='public' and pn.nspname='public' and parent.relname='manager_property_records'`);
  const key = (r: Record<string, unknown>) => [r.parent_table,r.child_table,r.conname,r.definition,r.confdeltype].join("|");
  if (JSON.stringify(constraints.rows.map(key).sort()) !== JSON.stringify(catalog.rows.filter((r) => r.parent_table === "manager_property_records").map(key).sort())) throw new Error("Draft catalog changed.");
  for (const row of constraints.rows) {
    const match = /^FOREIGN KEY \(([a-z_][a-z0-9_]*)\) REFERENCES [a-z_][a-z0-9_]*\(id\)/.exec(String(row.definition));
    if (!match || typeof row.child_table !== "string") throw new Error("Unsupported property FK.");
    const count = await db.query(`select count(*)::int count from public.${identifier(row.child_table)} where ${identifier(match[1])}=$1`, [input.propertyId]);
    if (count.rows[0]?.count !== 0) throw new Error(`Unexpected property descendant: ${row.child_table}`);
  }
  const columns = await db.query(`select c.table_name from information_schema.columns c join information_schema.tables t using(table_catalog,table_schema,table_name) where c.table_schema='public' and t.table_type='BASE TABLE' and c.column_name='property_id'`);
  for (const row of columns.rows) {
    if (typeof row.table_name !== "string") throw new Error("Unsupported property reference.");
    const count = await db.query(`select count(*)::int count from public.${identifier(row.table_name)} where property_id::text=$1`, [input.propertyId]);
    if (count.rows[0]?.count !== 0) throw new Error(`Unexpected property reference: ${row.table_name}`);
  }
}
/** Caller independently verifies the exact proof server has exited. */
export async function cleanupMetadataProperty(db: SupabaseClient, manifest: MetadataMirrorManifest, file: string, opts: { serverStopped: boolean; preflight: (input: Input, expected: "absent" | "live") => Promise<void> }): Promise<void> {
  if (!opts.serverStopped || !manifest.updatedAt || !Number.isFinite(Date.parse(manifest.updatedAt)) || !["saved", "delete_started"].includes(manifest.state)) throw new Error("Stopped server and saved draft required.");
  const found = await db.from("manager_property_records").select("id").eq("id", manifest.propertyId).limit(2);
  if (found.error || (found.data?.length ?? 0) > 1) throw new Error("Draft read failed.");
  const missing = !found.data?.length;
  if (missing && manifest.state !== "delete_started") throw new Error("Draft unexpectedly missing.");
  await opts.preflight(manifest, missing ? "absent" : "draft");
  if (!missing) {
    manifest.state = "delete_started"; persistMetadataManifest(file, manifest);
    const result = await db.from("manager_property_records").delete().eq("id", manifest.propertyId).eq("manager_user_id", manifest.managerId).eq("workspace_id", manifest.workspaceId).eq("status", "live").eq("updated_at", manifest.updatedAt).select("id");
    if (result.error || result.data?.length !== 1) throw new Error("Draft deletion uncertain; retain manifest.");
  }
  await opts.preflight(manifest, "absent");
  manifest.state = "cleaned"; persistMetadataManifest(file, manifest);
}
export async function preflightMetadataOnDev(input: Input, expected: "absent" | "live"): Promise<void> {
  if (!process.env.SUPABASE_DB_SSL_CA_FILE || !path.isAbsolute(process.env.SUPABASE_DB_SSL_CA_FILE)) throw new Error("Verified DEV CA required.");
  const modulePath = "../../scripts/security/nonproduction-database.mjs";
  const { nonproductionDatabaseConfig, connectNonproductionDatabase } = await import(/* @vite-ignore */ modulePath);
  const client = await connectNonproductionDatabase(nonproductionDatabaseConfig("emstjswhotsnyksqhqyf"));
  try { await client.query("BEGIN READ ONLY"); await client.query("SET LOCAL ROLE postgres"); await preflightMetadata(client, input, expected); await client.query("ROLLBACK"); } finally { await client.end(); }
}
