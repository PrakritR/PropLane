/**
 * PRP-370 repair, dev/test ONLY: release the AXIS id squatted by a stale duplicate
 * resident profile so `test:seed` can assign it to the canonical account.
 * Nulls `manager_id` on rows that hold the id but are NOT the canonical resident.
 */
import { createClient } from "@supabase/supabase-js";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!/emstjswhotsnyksqhqyf/.test(url ?? "")) throw new Error("dev/test project only — refusing to run");
const db = createClient(url, key, { auth: { persistSession: false } });
const axisId = process.env.E2E_RESIDENT_AXIS_ID?.trim() || "AXIS-TESTRSID";
const canonical = (process.env.E2E_RESIDENT_EMAIL || "resident@test.axis.local").toLowerCase();

const { data: holders, error } = await db.from("profiles").select("id,email,manager_id").eq("manager_id", axisId);
if (error) throw error;
const stale = (holders ?? []).filter(h => (h.email ?? "").toLowerCase() !== canonical);
if (!stale.length) { console.log(`nothing to release: ${axisId} is unheld or already canonical`); process.exit(0); }
for (const s of stale) {
  const { error: e } = await db.from("profiles").update({ manager_id: null }).eq("id", s.id);
  if (e) throw e;
  console.log(`released ${axisId} from ${s.email} (${s.id})`);
}
const { data: after } = await db.from("profiles").select("id,email").eq("manager_id", axisId);
console.log(`holders of ${axisId} now:`, (after ?? []).map(a => a.email).join(", ") || "(none)");
