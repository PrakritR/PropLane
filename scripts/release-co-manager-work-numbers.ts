#!/usr/bin/env npx tsx
/**
 * Retire the work numbers that pure co-managers were bought before numbers
 * became workspace-owned (one line per workspace, held by the owner).
 *
 * Until released, such a line keeps answering as the owner's workspace (the
 * inbound webhook collapses it), so this is deliberate cleanup, not a fix:
 * releasing tells anyone who saved the old number "not in service".
 *
 * Dry run (default — prints what WOULD be released, touches nothing):
 *   npx tsx --env-file=.env.local scripts/release-co-manager-work-numbers.ts
 *
 * Release for real:
 *   npx tsx --env-file=.env.local scripts/release-co-manager-work-numbers.ts --apply
 *
 * One account by email:
 *   npx tsx --env-file=.env.local scripts/release-co-manager-work-numbers.ts --email=co@test.proplane.local --apply
 *
 * Refuses the live production project unless ALLOW_PRODUCTION_RELEASE=1 is set
 * explicitly — a released number cannot be bought back.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isPureCoManagerWorkspace } from "../src/lib/sms/manager-workspace-role.server";
import { releaseTwilioNumber } from "../src/lib/twilio-provisioning";

const PRODUCTION_PROJECT_REF = "qahnczmilgptcedaqype";

type Candidate = { userId: string; email: string; phoneNumber: string; phoneNumberSid: string | null };

async function listCandidates(db: SupabaseClient, email?: string): Promise<Candidate[]> {
  const query = db
    .from("manager_sms_numbers")
    .select("manager_user_id, phone_number, phone_number_sid, provision_state")
    .neq("provision_state", "released")
    .not("phone_number", "is", null);
  const { data: rows, error } = await query;
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
      phoneNumber: String(row.phone_number),
      phoneNumberSid: row.phone_number_sid ? String(row.phone_number_sid) : null,
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
    console.log("No pure co-manager work numbers to release.");
    return;
  }
  for (const c of candidates) {
    console.log(`${apply ? "RELEASING" : "would release"} ${c.phoneNumber} (${c.email || c.userId})${c.phoneNumberSid ? "" : " — no provider sid on file; row only"}`);
    if (!apply) continue;
    const released = c.phoneNumberSid ? await releaseTwilioNumber(c.phoneNumberSid) : true;
    if (!released) {
      console.error(`  provider release failed for ${c.phoneNumber}; row left as-is`);
      continue;
    }
    const now = new Date().toISOString();
    const { error } = await db
      .from("manager_sms_numbers")
      .update({ provision_state: "released", released_at: now, updated_at: now })
      .eq("manager_user_id", c.userId);
    if (error) console.error(`  row update failed for ${c.phoneNumber}: ${error.message}`);
    await db.from("profiles").update({ sms_from_number: null }).eq("id", c.userId).eq("sms_from_number", c.phoneNumber);
  }
  if (!apply) console.log("\nDry run. Re-run with --apply to release.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
