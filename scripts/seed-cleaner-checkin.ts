#!/usr/bin/env npx tsx
/**
 * One-shot: give an existing VENDOR RECORD (the cleaner) the twice-monthly check-in "when are you coming next?"
 * on the 1st and 14th at 10:00 Pacific. The cleaner's name, phone and rate live on the vendor record, never in
 * this script. DRY-RUN by default: nothing is written until --apply.
 *
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/seed-cleaner-checkin.ts --manager=<uuid> --vendor=<vendor record id>
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/seed-cleaner-checkin.ts --manager=<uuid> --vendor=<id> --apply
 *
 * Options: --question "<text with {vendor}>" --hour <0-23> [10] --days 1,14
 * Idempotent: a check-in with the same cadence and question is left alone. The live project is refused unless
 * --allow-production is passed AND the owner has authorized it (AGENTS.md hard stops).
 */
import { createClient } from "@supabase/supabase-js";
import { makeVendorCheckInId, normalizeVendorCheckIn, normalizeVendorCheckIns, type VendorCheckIn } from "../src/lib/vendor-check-ins";

const PRODUCTION_REF = "qahnczmilgptcedaqype";
const DEFAULT_QUESTION = "Hi {vendor}, when are you coming to clean next? Reply with the day and time.";

const arg = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3).trim();

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) { console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }
  const managerUserId = arg("manager");
  const vendorId = arg("vendor");
  if (!managerUserId || !vendorId) { console.error("--manager=<uuid> and --vendor=<vendor record id> are required."); process.exit(1); }
  if (url.includes(PRODUCTION_REF) && !process.argv.includes("--allow-production")) {
    console.error("This is the live project: pass --allow-production (and have the owner's explicit authorization)."); process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const days = (arg("days") ?? "1,14").split(",").map((d) => Number(d.trim()));
  const hour = Number(arg("hour") ?? "10");
  const question = arg("question") ?? DEFAULT_QUESTION;

  const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: record, error } = await db.from("manager_vendor_records").select("id, updated_at, row_data").eq("id", vendorId).eq("manager_user_id", managerUserId).maybeSingle();
  if (error || !record) { console.error(error?.message ?? "Vendor record not found for this manager."); process.exit(1); }
  const row = record.row_data as Record<string, unknown>;
  const checkIn: VendorCheckIn | null = normalizeVendorCheckIn({
    id: makeVendorCheckInId(), question, cadence: { monthDays: days }, weekday: 1, hour, minute: 0, channel: "sms",
    enabled: true, onNoOrSilent: "inbox", anchorDate: new Date().toISOString().slice(0, 10), createdAt: new Date().toISOString(), log: [],
  });
  if (!checkIn) { console.error("Invalid check-in."); process.exit(1); }
  const existing = normalizeVendorCheckIns(row.checkIns);
  const duplicate = existing.find((c) => JSON.stringify(c.cadence) === JSON.stringify(checkIn.cadence) && c.question === checkIn.question);
  const plan = {
    target: url.replace(/^https:\/\//, "").split(".")[0], mode: apply ? "APPLY" : "DRY-RUN",
    vendor: { id: vendorId, name: row.name, hasPhone: Boolean(String(row.phone ?? "").trim()) },
    checkIn: { question, cadence: checkIn.cadence, hour },
  };
  if (duplicate) { console.log(JSON.stringify({ ...plan, result: "already configured, nothing to do" }, null, 2)); return; }
  if (!apply) { console.log(JSON.stringify({ ...plan, result: "dry run: nothing written (pass --apply)" }, null, 2)); return; }
  const { error: writeError } = await db
    .from("manager_vendor_records")
    .update({ row_data: { ...row, checkIns: [...existing, checkIn] }, updated_at: new Date().toISOString() })
    .eq("id", vendorId).eq("manager_user_id", managerUserId);
  if (writeError) { console.error(writeError.message); process.exit(1); }
  console.log(JSON.stringify({ ...plan, result: "added", checkInId: checkIn.id }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
