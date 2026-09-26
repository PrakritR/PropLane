// Deletes the night-vendor-signup-* proof fixtures created tonight: the
// auth users (cascades to profiles + vendor_business_profiles) and any
// manager_vendor_records rows the add-to-roster proof created for them.
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const { data: listData, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
if (listErr) throw new Error(`listUsers: ${listErr.message}`);
const targets = (listData?.users ?? []).filter((u) => (u.email ?? "").startsWith("night-vendor-signup-"));

for (const user of targets) {
  const { error: rosterErr } = await supabase.from("manager_vendor_records").delete().eq("vendor_user_id", user.id);
  if (rosterErr) console.warn(`manager_vendor_records cleanup for ${user.email}: ${rosterErr.message}`);

  const { error: delErr } = await supabase.auth.admin.deleteUser(user.id);
  if (delErr) console.warn(`deleteUser ${user.email}: ${delErr.message}`);
  else console.log(`deleted ${user.email}`);
}

console.log(`done — ${targets.length} fixture account(s) removed.`);
