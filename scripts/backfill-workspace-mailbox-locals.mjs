#!/usr/bin/env node
/**
 * Rename every ACTIVE workspace work-email local part to the naming rule
 * (workspace name compacted, see src/lib/manager-assistant-email/workspace-mailbox-local-rule.mjs).
 * Dry-run by default; --apply writes. Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 * Same semantics as setWorkspaceAssistantMailboxLocal: update the local, hold the
 * old one as a 30-day alias. Idempotent: a row already on the rule is skipped.
 */
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { workspaceMailboxLocalFor } from "../src/lib/manager-assistant-email/workspace-mailbox-local-rule.mjs";

const ALIAS_DAYS = 30;

/** Pure: pick the first free candidate (base, base-2 … base-9). `taken` is a Set of locals held by OTHER rows/owners. */
export function pickLocal(base, taken) {
  const candidates = [base, ...Array.from({ length: 8 }, (_, i) => `${base}-${i + 2}`)];
  return candidates.find((c) => c.length <= 32 && !taken.has(c)) ?? null;
}

/** Pure: plan the renames for rows [{id, workspaceId, ownerId, mailboxLocal, workspaceName, ownerFirst}]. */
export function planRenames(rows, aliasesByLocal = new Map()) {
  const held = new Map(rows.map((r) => [r.mailboxLocal, r.id]));
  const plans = [];
  for (const row of rows) {
    const base = workspaceMailboxLocalFor(row.workspaceName, row.ownerFirst);
    if (!base) continue;
    const matches = row.mailboxLocal === base || new RegExp(`^${base}-[2-9]$`).test(row.mailboxLocal);
    if (matches) continue;
    const taken = new Set();
    for (const [local, id] of held) if (id !== row.id) taken.add(local);
    for (const [local, owner] of aliasesByLocal) if (owner !== row.ownerId) taken.add(local);
    const next = pickLocal(base, taken);
    if (!next || next === row.mailboxLocal) continue;
    held.delete(row.mailboxLocal);
    held.set(next, row.id);
    plans.push({ ...row, next });
  }
  return plans;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  const db = createClient(url, key, { auth: { persistSession: false } });

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
  for (const p of plans) {
    console.log(`${p.workspaceName || p.workspaceId}: ${p.mailboxLocal} -> ${p.next}`);
    if (!apply) continue;
    const { error: upErr } = await db
      .from("manager_assistant_emails")
      .update({ mailbox_local: p.next, updated_at: new Date().toISOString() })
      .eq("id", p.id)
      .eq("provision_state", "active");
    if (upErr) {
      console.log(`  skipped: ${upErr.message}`);
      continue;
    }
    const expires = new Date(now + ALIAS_DAYS * 86400000).toISOString();
    await db.from("manager_assistant_email_aliases").upsert(
      { mailbox_local: p.mailboxLocal, assistant_email_id: p.id, owner_user_id: p.ownerId, released_at: new Date().toISOString(), expires_at: expires },
      { onConflict: "mailbox_local" },
    );
    await db.from("manager_assistant_email_aliases").delete().eq("mailbox_local", p.next).eq("owner_user_id", p.ownerId);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
