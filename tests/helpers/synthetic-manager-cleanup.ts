/** Test-only no-property signup fixture cleanup. Never call for a real account. */
import { existsSync, openSync, closeSync, fsyncSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import ts from "typescript";

const DEV = "https://emstjswhotsnyksqhqyf.supabase.co";
const EMAIL = /^get-started-e2e-[0-9]+@example\.invalid$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Row = Record<string, unknown>;
type Child = { table: "email_onboarding_handoffs" | "manager_automation_settings" | "manager_purchases"; key: "id" | "manager_user_id"; id: string; ownerColumn: "user_id" | "manager_user_id" };
export type SyntheticManagerManifest = { email: string; authId: string | null; absentBeforeSignup: true; children: Child[]; beforeCounts?: Record<string, number>; afterCounts?: Record<string, number>; state: "reserved" | "identified" | "inspected" | "cleaned" };

function save(file: string, manifest: SyntheticManagerManifest) {
  if (!path.isAbsolute(file) || !lstatSync(path.dirname(file)).isDirectory() || (lstatSync(path.dirname(file)).mode & 0o777) !== 0o700) throw new Error("Synthetic manifest must have an absolute private path.");
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(manifest)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
}
function validateTarget(url: string, email: string) {
  if (url !== DEV || !EMAIL.test(email)) throw new Error("Refusing non-DEV or non-synthetic cleanup target.");
}
async function findExactUser(db: SupabaseClient, email: string): Promise<User | null> {
  for (let page = 1; page <= 1000; page++) {
    const result = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (result.error) throw new Error("Could not verify synthetic email availability.");
    const matches = result.data.users.filter((user) => user.email?.trim().toLowerCase() === email);
    if (matches.length > 1) throw new Error("Synthetic email is ambiguous.");
    if (matches[0]) return matches[0];
    if (result.data.users.length < 1000) return null;
  }
  throw new Error("Synthetic email lookup exceeded its bound.");
}
export async function reserveSyntheticManager(db: SupabaseClient, url: string, email: string, manifestFile: string): Promise<SyntheticManagerManifest> {
  validateTarget(url, email);
  if (existsSync(manifestFile)) throw new Error("Synthetic manifest already exists.");
  if (await findExactUser(db, email)) throw new Error("Synthetic email already exists.");
  const manifest: SyntheticManagerManifest = { email, authId: null, absentBeforeSignup: true, children: [], state: "reserved" };
  save(manifestFile, manifest);
  return manifest;
}
export async function identifySyntheticManager(db: SupabaseClient, url: string, manifest: SyntheticManagerManifest, manifestFile: string): Promise<string> {
  validateTarget(url, manifest.email);
  const user = await findExactUser(db, manifest.email);
  if (!user || !UUID.test(user.id) || user.app_metadata?.proplane_email_onboarding !== true) throw new Error("Synthetic signup identity unavailable.");
  if (manifest.authId && manifest.authId !== user.id) throw new Error("Synthetic identity changed.");
  manifest.authId = user.id; manifest.state = "identified"; save(manifestFile, manifest);
  return user.id;
}
/** Read only literal manager ID rules; refuse syntax we cannot inspect safely. */
function managerScopeRules(): Array<{ table: string; columns: string[] }> {
  const source = ts.createSourceFile("account-purge-manifest.ts", readFileSync(path.resolve("src/lib/auth/account-purge-manifest.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  let entries: ts.ArrayLiteralExpression | null = null;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.name.text === "ACCOUNT_PURGE_TABLES" && declaration.initializer && ts.isArrayLiteralExpression(declaration.initializer)) entries = declaration.initializer;
  }
  if (!entries) throw new Error("Account purge scope is unavailable.");
  const rules: Array<{ table: string; columns: string[] }> = [];
  const property = (node: ts.ObjectLiteralExpression, name: string) => node.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(source).replace(/["']/g, "") === name) as ts.PropertyAssignment | undefined;
  for (const entry of entries.elements) {
    if (!ts.isObjectLiteralExpression(entry)) throw new Error("Unsupported account purge manifest entry.");
    const table = property(entry, "table")?.initializer;
    const manager = property(entry, "manager")?.initializer;
    if (!table || !ts.isStringLiteral(table)) throw new Error("Unsupported account purge table.");
    if (!manager) continue;
    if (!ts.isObjectLiteralExpression(manager)) throw new Error("Unsupported manager purge rule.");
    const columns: string[] = [];
    for (const key of ["ids", "detachIds"]) {
      const values = property(manager, key)?.initializer;
      if (!values) continue;
      if (!ts.isArrayLiteralExpression(values) || values.elements.some((value) => !ts.isStringLiteral(value))) throw new Error("Unsupported manager ownership rule.");
      columns.push(...values.elements.map((value) => (value as ts.StringLiteral).text));
    }
    rules.push({ table: table.text, columns });
  }
  return rules;
}
function rejectProviderReferences(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "stripe_checkout_session_id" && typeof item === "string" && /^axis_(?:intent|pending)_[a-f0-9-]+$/i.test(item)) continue;
    if (/(?:stripe_|twilio_|access_token|refresh_token|api_key)/i.test(key) && item != null && item !== "" && item !== false) throw new Error("Synthetic fixture has an external provider reference.");
    if (typeof item === "object") rejectProviderReferences(item);
  }
}
function checkPurchase(row: Row) {
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith("stripe_") || value == null || value === "") continue;
    if (key === "stripe_checkout_session_id" && typeof value === "string" && /^axis_(?:intent|pending)_[a-f0-9-]+$/i.test(value)) continue;
    throw new Error("Synthetic fixture has an external payment reference.");
  }
}
async function readRows(db: SupabaseClient, table: string, column: string, value: string): Promise<Row[]> {
  const result = await db.from(table).select("*").eq(column, value).limit(3);
  if (result.error) {
    if (["42P01", "PGRST205"].includes(result.error.code ?? "")) return [];
    throw new Error(`Synthetic scope read failed: ${table}`);
  }
  if ((result.data ?? []).length >= 3) throw new Error(`Synthetic scope exceeds bound: ${table}`);
  return (result.data ?? []) as Row[];
}
/** Capture exact children and refuse all other manifest-linked rows before deleting. */
async function inspect(db: SupabaseClient, manifest: SyntheticManagerManifest): Promise<Child[]> {
  const userId = manifest.authId!;
  const supported = new Map<string, { key: Child["key"]; owner: Child["ownerColumn"] }>([
    ["email_onboarding_handoffs", { key: "id", owner: "user_id" }],
    ["manager_automation_settings", { key: "manager_user_id", owner: "manager_user_id" }],
    ["manager_purchases", { key: "id", owner: "user_id" }],
  ]);
  const children = new Map<string, Child>();
  const visited = new Set<string>();
  for (const rule of managerScopeRules()) {
    for (const column of rule.columns) {
      const scanKey = `${rule.table}:${column}`; if (visited.has(scanKey)) continue; visited.add(scanKey);
      const rows = await readRows(db, rule.table, column, userId);
      if (!rows.length) continue;
      const spec = supported.get(rule.table);
      if (!spec || column !== spec.owner) throw new Error(`Unexpected synthetic linked row: ${rule.table}`);
      for (const row of rows) {
        if (row[spec.owner] !== userId || typeof row[spec.key] !== "string") throw new Error(`Synthetic ownership changed: ${rule.table}`);
        if (rule.table === "manager_purchases") checkPurchase(row);
        rejectProviderReferences(row);
        const child = { table: rule.table as Child["table"], key: spec.key, id: row[spec.key] as string, ownerColumn: spec.owner };
        children.set(`${child.table}:${child.id}`, child);
      }
    }
  }
  const roles = await readRows(db, "profile_roles", "user_id", userId);
  if (roles.some((row) => row.role !== "manager")) throw new Error("Synthetic account has an unexpected role.");
  return [...children.values()].sort((a, b) => a.table.localeCompare(b.table) || a.id.localeCompare(b.id));
}
export async function captureSyntheticManagerChildren(db: SupabaseClient, manifest: SyntheticManagerManifest, manifestFile: string): Promise<void> {
  if (!manifest.authId || !UUID.test(manifest.authId)) throw new Error("Synthetic subject is unavailable.");
  manifest.children = await inspect(db, manifest);
  manifest.beforeCounts = { children: manifest.children.length, roles: (await readRows(db, "profile_roles", "user_id", manifest.authId)).length, profiles: (await readRows(db, "profiles", "id", manifest.authId)).length };
  manifest.state = "inspected";
  save(manifestFile, manifest);
}
export async function cleanupSyntheticManager(db: SupabaseClient, url: string, manifest: SyntheticManagerManifest, manifestFile: string): Promise<void> {
  validateTarget(url, manifest.email);
  if (!manifest.absentBeforeSignup) throw new Error("Synthetic signup was not reserved.");
  let userId = manifest.authId;
  if (!userId) {
    const pending = await findExactUser(db, manifest.email);
    if (!pending) { manifest.state = "cleaned"; save(manifestFile, manifest); return; }
    userId = await identifySyntheticManager(db, url, manifest, manifestFile);
  }
  if (!UUID.test(userId)) throw new Error("Invalid synthetic subject.");
  const auth = await db.auth.admin.getUserById(userId);
  if (auth.error || auth.data.user?.id !== userId || auth.data.user.email?.trim().toLowerCase() !== manifest.email || auth.data.user.app_metadata?.proplane_email_onboarding !== true || (auth.data.user.identities ?? []).some((identity) => identity.provider !== "email")) throw new Error("Synthetic Auth ownership could not be verified.");
  const profiles = await readRows(db, "profiles", "id", userId);
  for (const row of profiles) rejectProviderReferences(row);
  const children = await inspect(db, manifest);
  if (manifest.state === "inspected" && JSON.stringify(manifest.children) !== JSON.stringify(children)) throw new Error("Synthetic linked rows changed during cleanup.");
  manifest.children = children;
  manifest.beforeCounts = { children: children.length, roles: (await readRows(db, "profile_roles", "user_id", userId)).length, profiles: profiles.length };
  manifest.state = "inspected"; save(manifestFile, manifest);
  // Recheck the complete scope before the first deletion; each delete is also
  // pinned to both the exact recorded key and exact owner. Contexts must be closed.
  if (JSON.stringify(await inspect(db, manifest)) !== JSON.stringify(children)) throw new Error("Synthetic linked rows changed during cleanup.");
  for (const child of children) {
    const deleted = await db.from(child.table).delete().eq(child.key, child.id).eq(child.ownerColumn, userId).select(child.key);
    if (deleted.error || deleted.data?.length !== 1) throw new Error(`Synthetic delete failed: ${child.table}`);
  }
  const roles = await db.from("profile_roles").delete().eq("user_id", userId).eq("role", "manager");
  if (roles.error) throw new Error("Synthetic role deletion failed.");
  const profile = await db.from("profiles").delete().eq("id", userId);
  if (profile.error) throw new Error("Synthetic profile deletion failed.");
  const deletedUser = await db.auth.admin.deleteUser(userId);
  if (deletedUser.error) throw new Error("Synthetic Auth deletion failed.");
  const after = await db.auth.admin.getUserById(userId);
  if (after.data.user || after.error?.code !== "user_not_found") throw new Error("Synthetic Auth absence was not confirmed.");
  for (const child of children) if ((await readRows(db, child.table, child.key, child.id)).length) throw new Error(`Synthetic child remains: ${child.table}`);
  if ((await readRows(db, "profile_roles", "user_id", userId)).length || (await readRows(db, "profiles", "id", userId)).length) throw new Error("Synthetic identity rows remain.");
  manifest.afterCounts = { children: 0, roles: 0, profiles: 0, auth: 0 };
  manifest.state = "cleaned"; save(manifestFile, manifest);
}
