#!/usr/bin/env node
/**
 * Rename every ACTIVE workspace work-email local part to the naming rule
 * (workspace name compacted, see src/lib/manager-assistant-email/workspace-mailbox-local-rule.mjs).
 * Dry-run by default; --apply writes. Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 * Same semantics as setWorkspaceAssistantMailboxLocal: update the local, hold the
 * old one as a 30-day alias. Idempotent: a row already on the rule is skipped.
 *
 * --service: PropLane-managed (is_service) workspaces only, by the service rule ("1. Ambika" -> ambikahomes).
 * It MINTS for each non-archived one that has no address, and otherwise leaves an existing address alone: a
 * workspace that ran self-serve before PropLane took it over is on a published `{workspace-slug}@`, and a staff
 * one may be hand-picked, so nothing here may move it (the same invariant `attachWorkspaceToService` keeps).
 * --rename-workspace=<workspaceId> (or `--rename-workspace <workspaceId>`; repeatable) is the explicit opt-in
 * for the one workspace an operator does want moved onto its service-rule local, whatever its address came
 * from. The value must be a UUID; anything else exits non-zero rather than running mint-only in silence.
 * Prints the plan table; writes only with --apply.
 *
 * Refuses the production project unless --allow-production is passed (any mode).
 */
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { localFollowsBase, serviceWorkspaceMailboxLocalFor, workspaceMailboxLocalFor } from "../src/lib/manager-assistant-email/workspace-mailbox-local-rule.mjs";

const PROD_REF = (process.env.AXIS_PROD_SUPABASE_REF || "qahnczmilgptcedaqype").trim();

/** Pure: whether `url` names the production Supabase project (host match, like assertNonProdDatabase). */
export function isProductionSupabaseUrl(url) {
  return [PROD_REF, "qahnczmilgptcedaqype"].some((ref) => String(url ?? "").includes(`${ref}.supabase.co`));
}

const ALIAS_DAYS = 30;

const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RENAME_FLAG = "--rename-workspace";

/**
 * Pure: the `--rename-workspace` ids, in either `--rename-workspace <id>` or `--rename-workspace=<id>` form.
 * Throws on a missing or malformed value, so `main` exits non-zero rather than running mint-only and leaving
 * the operator to conclude nothing needed renaming - the kind of silence somebody retries with --apply.
 */
export function parseRenameWorkspaceIds(argv) {
  const out = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "");
    const inline = arg.startsWith(`${RENAME_FLAG}=`);
    if (arg !== RENAME_FLAG && !inline) continue;
    const raw = (inline ? arg.slice(RENAME_FLAG.length + 1) : String(argv[i + 1] ?? "")).trim();
    if (!raw || raw.startsWith("--")) {
      throw new Error(`${RENAME_FLAG} needs a workspace id, e.g. ${RENAME_FLAG}=00000000-0000-4000-8000-000000000000`);
    }
    if (!WORKSPACE_ID_PATTERN.test(raw)) {
      throw new Error(`${RENAME_FLAG}: "${raw}" is not a workspace id (expected a UUID).`);
    }
    out.add(raw.toLowerCase());
    if (!inline) i += 1;
  }
  return out;
}

/** Pure: pick the first free candidate (base, base-2 … base-9). `taken` is a Set of locals held by OTHER rows/owners. */
export function pickLocal(base, taken) {
  const candidates = [base, ...Array.from({ length: 8 }, (_, i) => `${base}-${i + 2}`)];
  return candidates.find((c) => c.length <= 32 && !taken.has(c)) ?? null;
}

/**
 * Pure: plan the renames for rows [{id, workspaceId, ownerId, mailboxLocal, workspaceName, ownerFirst}].
 *
 * A renamed-away local is NOT free for another workspace: apply() holds it as a 30-day alias for the
 * workspace that left it, and `resolveAssistantMailboxByLocal` prefers an ACTIVE row over an alias — so
 * handing it to a different owner in the same run would route the first workspace's grace-period mail
 * into the second one. The alias map therefore grows as the plan does, exactly as the server path
 * (`checkWorkspaceAssistantMailboxLocal` -> `findActiveMailboxLocalAlias`) refuses it.
 */
export function planRenames(rows, aliasesByLocal = new Map()) {
  const held = new Map(rows.map((r) => [r.mailboxLocal, r.id]));
  const aliases = new Map(aliasesByLocal);
  const plans = [];
  for (const row of rows) {
    const base = workspaceMailboxLocalFor(row.workspaceName, row.ownerFirst);
    if (!base) continue;
    const matches = row.mailboxLocal === base || new RegExp(`^${base}-[2-9]$`).test(row.mailboxLocal);
    if (matches) continue;
    const taken = new Set();
    for (const [local, id] of held) if (id !== row.id) taken.add(local);
    for (const [local, owner] of aliases) if (owner !== row.ownerId) taken.add(local);
    const next = pickLocal(base, taken);
    if (!next || next === row.mailboxLocal) continue;
    held.delete(row.mailboxLocal);
    held.set(next, row.id);
    // The old local becomes this owner's alias; the new one stops being anybody's (apply deletes it).
    aliases.set(row.mailboxLocal, row.ownerId);
    if (aliases.get(next) === row.ownerId) aliases.delete(next);
    plans.push({ ...row, next });
  }
  return plans;
}

/**
 * Pure: plan the service-workspace pass. rows: [{workspaceId, workspaceName, ownerId, ownerFirst, email}] where email is
 * null (no active address) or {id, mailboxLocal}. Returns [{kind: "mint" | "rename", workspaceId, workspaceName, ownerId,
 * emailId, mailboxLocal (current or null), next}]. A row already on the service rule's local (or its -2..-9 suffix) is
 * left alone, so a second run plans nothing. Locals held by any row, planned or existing, and another owner's live alias
 * are never handed out.
 *
 * A workspace that ALREADY holds an address is only planned when its id is in `renameWorkspaceIds`
 * (`--rename-workspace`). Without that opt-in the pass is mint-only: the address may be a self-serve
 * `{workspace-slug}@` published on listings and in the public listing payload, and this script must not do what
 * the attach path was fixed to never do - retire a live address behind a 30-day alias.
 */
export function planServiceEmails(rows, aliasesByLocal = new Map(), renameWorkspaceIds = new Set()) {
  const held = new Map();
  for (const r of rows) if (r.email) held.set(r.email.mailboxLocal, r.email.id ?? r.workspaceId);
  const aliases = new Map(aliasesByLocal);
  const plans = [];
  for (const row of rows) {
    const base = serviceWorkspaceMailboxLocalFor(row.workspaceName, row.ownerFirst);
    if (!base) continue;
    const current = row.email?.mailboxLocal ?? null;
    if (current && localFollowsBase(current, base)) continue;
    if (current && !renameWorkspaceIds.has(row.workspaceId)) continue;
    const holderId = row.email ? (row.email.id ?? row.workspaceId) : row.workspaceId;
    const taken = new Set();
    for (const [local, id] of held) if (id !== holderId) taken.add(local);
    for (const [local, owner] of aliases) if (owner !== row.ownerId) taken.add(local);
    const next = pickLocal(base, taken);
    if (!next || next === current) continue;
    if (current) {
      held.delete(current);
      aliases.set(current, row.ownerId);
    }
    held.set(next, holderId);
    if (aliases.get(next) === row.ownerId) aliases.delete(next);
    plans.push({
      kind: current ? "rename" : "mint",
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      ownerId: row.ownerId,
      emailId: row.email?.id ?? null,
      mailboxLocal: current,
      next,
    });
  }
  return plans;
}

/** Pure: the plan as an aligned table (workspace id, name, current -> new). */
export function formatServicePlan(plans) {
  const header = ["workspace id", "name", "current", "new"];
  const lines = plans.map((p) => [p.workspaceId, p.workspaceName || "(unnamed)", p.mailboxLocal ?? "(none)", p.next]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => String(l[i]).length)));
  const fmt = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ").trimEnd();
  return [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...lines.map(fmt)].join("\n");
}

async function runService(db, apply, renameWorkspaceIds = new Set()) {
  const { data: workspaces, error: wsErr } = await db
    .from("portal_workspaces")
    .select("id, name, owner_user_id")
    .eq("is_service", true)
    .is("archived_at", null)
    .order("name");
  if (wsErr) throw wsErr;
  const wsIds = (workspaces ?? []).map((w) => w.id);
  const ownerIds = [...new Set((workspaces ?? []).map((w) => w.owner_user_id))];
  const [{ data: emails, error: emErr }, { data: profiles }, { data: aliases }, { data: allActive }] = await Promise.all([
    wsIds.length
      ? db.from("manager_assistant_emails").select("id, workspace_id, mailbox_local").eq("provision_state", "active").in("workspace_id", wsIds)
      : Promise.resolve({ data: [], error: null }),
    ownerIds.length ? db.from("profiles").select("id, full_name, email").in("id", ownerIds) : Promise.resolve({ data: [] }),
    db.from("manager_assistant_email_aliases").select("mailbox_local, owner_user_id, expires_at"),
    // Every active local, so a collision with a non-service workspace is seen too.
    db.from("manager_assistant_emails").select("id, mailbox_local").eq("provision_state", "active").not("mailbox_local", "is", null),
  ]);
  if (emErr) throw emErr;
  const prof = new Map((profiles ?? []).map((p) => [p.id, p]));
  const now = Date.now();
  const aliasesByLocal = new Map(
    (aliases ?? []).filter((a) => new Date(a.expires_at).getTime() > now).map((a) => [a.mailbox_local, a.owner_user_id]),
  );
  const byWorkspace = new Map((emails ?? []).map((e) => [e.workspace_id, e]));
  const rows = (workspaces ?? []).map((w) => {
    const p = prof.get(w.owner_user_id);
    const first = String(p?.full_name ?? "").trim().split(/\s+/)[0] || String(p?.email ?? "").split("@")[0] || "";
    const e = byWorkspace.get(w.id);
    return {
      workspaceId: w.id,
      workspaceName: String(w.name ?? "").trim(),
      ownerId: w.owner_user_id,
      ownerFirst: first,
      email: e ? { id: e.id, mailboxLocal: String(e.mailbox_local ?? "").toLowerCase() } : null,
    };
  });
  // Locals held by non-service rows are taken as well: model them as extra rows with no plan of their own.
  const serviceEmailIds = new Set(rows.map((r) => r.email?.id).filter(Boolean));
  const others = (allActive ?? [])
    .filter((e) => !serviceEmailIds.has(e.id))
    .map((e) => ({ workspaceId: `other:${e.id}`, workspaceName: "", ownerId: `other:${e.id}`, ownerFirst: "", email: { id: e.id, mailboxLocal: String(e.mailbox_local).toLowerCase() } }));
  const plans = planServiceEmails([...rows, ...others], aliasesByLocal, renameWorkspaceIds).filter(
    (p) => !String(p.workspaceId).startsWith("other:"),
  );
  const unknownAsked = [...renameWorkspaceIds].filter((id) => !rows.some((r) => r.workspaceId === id));
  if (unknownAsked.length) console.log(`--rename-workspace named ${unknownAsked.length} id(s) that are not live service workspaces: ${unknownAsked.join(", ")}`);

  console.log(`${apply ? "APPLY" : "DRY RUN"} (service): ${plans.length} of ${rows.length} service workspaces to change`);
  if (plans.length) console.log(formatServicePlan(plans));
  if (!apply) return;
  let failed = 0;
  for (const p of plans) {
    const nowIso = new Date().toISOString();
    if (p.kind === "mint") {
      const { error } = await db.from("manager_assistant_emails").insert({
        manager_user_id: p.ownerId,
        workspace_id: p.workspaceId,
        inbox_token: randomBytes(9).toString("base64url").slice(0, 12),
        mailbox_local: p.next,
        provision_state: "active",
        created_at: nowIso,
        updated_at: nowIso,
      });
      if (error) {
        console.log(`  failed (mint ${p.workspaceName || p.workspaceId}): ${error.message}`);
        failed += 1;
      }
      continue;
    }
    const expires = new Date(now + ALIAS_DAYS * 86400000).toISOString();
    const { error: aliasErr } = await db.from("manager_assistant_email_aliases").upsert(
      { mailbox_local: p.mailboxLocal, assistant_email_id: p.emailId, owner_user_id: p.ownerId, released_at: nowIso, expires_at: expires },
      { onConflict: "mailbox_local" },
    );
    if (aliasErr) {
      console.log(`  failed (alias ${p.workspaceName || p.workspaceId}): ${aliasErr.message}`);
      failed += 1;
      continue;
    }
    const { error: upErr } = await db.from("manager_assistant_emails").update({ mailbox_local: p.next, updated_at: nowIso }).eq("id", p.emailId).eq("provision_state", "active");
    if (upErr) {
      console.log(`  failed (rename ${p.workspaceName || p.workspaceId}): ${upErr.message}`);
      failed += 1;
      continue;
    }
    await db.from("manager_assistant_email_aliases").delete().eq("mailbox_local", p.next).eq("owner_user_id", p.ownerId);
  }
  console.log(`${failed} failed of ${plans.length}`);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const service = process.argv.includes("--service");
  const renameWorkspaceIds = parseRenameWorkspaceIds(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  if (isProductionSupabaseUrl(url) && !process.argv.includes("--allow-production")) {
    throw new Error("SUPABASE_URL is the production project. Refusing; pass --allow-production to run against it.");
  }
  const db = createClient(url, key, { auth: { persistSession: false } });
  if (service) return runService(db, apply, renameWorkspaceIds);
  if (renameWorkspaceIds.size) throw new Error("--rename-workspace only applies to --service.");

  const { data: emails, error } = await db
    .from("manager_assistant_emails")
    .select("id, workspace_id, manager_user_id, mailbox_local")
    .eq("provision_state", "active")
    .not("mailbox_local", "is", null);
  if (error) throw error;
  const wsIds = [...new Set(emails.map((e) => e.workspace_id).filter(Boolean))];
  const ownerIds = [...new Set(emails.map((e) => e.manager_user_id))];
  const [{ data: ws }, { data: profiles }, { data: aliases }] = await Promise.all([
    db.from("portal_workspaces").select("id, name").in("id", wsIds),
    db.from("profiles").select("id, full_name, email").in("id", ownerIds),
    db.from("manager_assistant_email_aliases").select("mailbox_local, owner_user_id, expires_at"),
  ]);
  const wsName = new Map((ws ?? []).map((w) => [w.id, String(w.name ?? "").trim()]));
  const prof = new Map((profiles ?? []).map((p) => [p.id, p]));
  const now = Date.now();
  const aliasesByLocal = new Map(
    (aliases ?? []).filter((a) => new Date(a.expires_at).getTime() > now).map((a) => [a.mailbox_local, a.owner_user_id]),
  );
  const rows = emails
    .filter((e) => e.workspace_id)
    .map((e) => {
      const p = prof.get(e.manager_user_id);
      const first = String(p?.full_name ?? "").trim().split(/\s+/)[0] || String(p?.email ?? "").split("@")[0] || "";
      return {
        id: e.id,
        workspaceId: e.workspace_id,
        ownerId: e.manager_user_id,
        mailboxLocal: String(e.mailbox_local).toLowerCase(),
        workspaceName: wsName.get(e.workspace_id) ?? "",
        ownerFirst: first,
      };
    });

  const plans = planRenames(rows, aliasesByLocal);
  console.log(`${apply ? "APPLY" : "DRY RUN"}: ${plans.length} of ${rows.length} workspaces to rename`);
  let failed = 0;
  for (const p of plans) {
    console.log(`${p.workspaceName || p.workspaceId}: ${p.mailboxLocal} -> ${p.next}`);
    if (!apply) continue;
    const expires = new Date(now + ALIAS_DAYS * 86400000).toISOString();
    // Alias first: a failure after this never leaves the old address unrouted.
    const { error: aliasErr } = await db.from("manager_assistant_email_aliases").upsert(
      { mailbox_local: p.mailboxLocal, assistant_email_id: p.id, owner_user_id: p.ownerId, released_at: new Date().toISOString(), expires_at: expires },
      { onConflict: "mailbox_local" },
    );
    if (aliasErr) {
      console.log(`  failed (alias): ${aliasErr.message}`);
      failed += 1;
      continue;
    }
    const { error: upErr } = await db
      .from("manager_assistant_emails")
      .update({ mailbox_local: p.next, updated_at: new Date().toISOString() })
      .eq("id", p.id)
      .eq("provision_state", "active");
    if (upErr) {
      console.log(`  skipped: ${upErr.message}`);
      failed += 1;
      continue;
    }
    const { error: delErr } = await db.from("manager_assistant_email_aliases").delete().eq("mailbox_local", p.next).eq("owner_user_id", p.ownerId);
    if (delErr) {
      console.log(`  failed (alias cleanup): ${delErr.message}`);
      failed += 1;
    }
  }
  if (apply) console.log(`${failed} failed of ${plans.length}`);
}


if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
