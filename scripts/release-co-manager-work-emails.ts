#!/usr/bin/env npx tsx
/**
 * Retire the work emails that pure co-managers requested before addresses
 * became workspace-owned (one address per workspace, held by the owner).
 *
 * Until released, such an address keeps answering as the owner's workspace
 * (the inbound path collapses it), so this is deliberate cleanup, not a fix:
 * releasing tells anyone who saved the old address that it is gone. The twin
 * of release-co-manager-work-numbers.ts; nothing at the provider to release,
 * the row's provision_state is the whole switch.
 *
 * Dry run (default — prints what WOULD be released, touches nothing):
 *   npx tsx --env-file=.env.local scripts/release-co-manager-work-emails.ts
 *
 * Release for real:
 *   npx tsx --env-file=.env.local scripts/release-co-manager-work-emails.ts --apply
 *
 * One account by email:
 *   npx tsx --env-file=.env.local scripts/release-co-manager-work-emails.ts --email=co@test.proplane.local --apply
 *
 * Refuses the live production project unless ALLOW_PRODUCTION_RELEASE=1 is set
 * explicitly.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isPureCoManagerWorkspace } from "../src/lib/sms/manager-workspace-role.server";

const PRODUCTION_PROJECT_REF = "qahnczmilgptcedaqype";

type Candidate = { userId: string; email: string; mailboxLocal: string; token: string };

async function listCandidates(db: SupabaseClient, email?: string): Promise<Candidate[]> {
  const { data: rows, error } = await db
    .from("manager_assistant_emails")
    .select("manager_user_id, inbox_token, mailbox_local, provision_state")
    .eq("provision_state", "active")
    // An address placed in a workspace belongs to that workspace — a
    // co-manager may own one in a workspace of their own. Only unplaced
    // legacy rows are candidates.
    .is("workspace_id", null);
  if (error) throw error;
  const ids = (rows ?? []).map((r) => String(r.manager_user_id));
  if (ids.length === 0) return [];
  const { data: profiles } = await db.from("profiles").select("id, email").in("id", ids);
  const emailById = new Map((profiles ?? []).map((p) => [String(p.id), String(p.email ?? "")]));
  const out: Candidate[] = [];
  for (const row of rows ?? []) {
    const userId = String(row.manager_user_id);
    const rowEmail = emailById.get(userId) ?? "";
    if (email && rowEmail.toLowerCase() !== email.toLowerCase()) continue;
    if (!(await isPureCoManagerWorkspace(db, userId))) continue;
    out.push({
      userId,
      email: rowEmail,
      mailboxLocal: String(row.mailbox_local ?? ""),
      token: String(row.inbox_token ?? ""),
    });
  }
  return out;
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  if (url.includes(PRODUCTION_PROJECT_REF) && process.env.ALLOW_PRODUCTION_RELEASE !== "1") {
    console.error("Refusing to run against the live production project without ALLOW_PRODUCTION_RELEASE=1.");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const email = process.argv.find((a) => a.startsWith("--email="))?.split("=")[1];

  const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const candidates = await listCandidates(db, email);
  if (candidates.length === 0) {
    console.log("No pure co-manager work emails to release.");
    return;
  }
  for (const c of candidates) {
    const label = c.mailboxLocal || `assistant+${c.token}`;
    console.log(`${apply ? "RELEASING" : "would release"} ${label} (${c.email || c.userId})`);
    if (!apply) continue;
    const now = new Date().toISOString();
    const { error } = await db
      .from("manager_assistant_emails")
      .update({ provision_state: "released", updated_at: now })
      .eq("manager_user_id", c.userId);
    if (error) console.error(`  row update failed for ${label}: ${error.message}`);
  }
  if (!apply) console.log("\nDry run. Re-run with --apply to release.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
