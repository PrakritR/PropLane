import { createClient } from "@supabase/supabase-js";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const db = createClient(url, key, { auth: { persistSession: false } });
console.log("project:", url);
for (const t of ["resident_inspections","resident_housemate_sharing","manager_assistant_emails","rate_limit_buckets","manager_invite_links"]) {
  const { error } = await db.from(t).select("*").limit(1);
  console.log(`  ${t.padEnd(28)} ${error ? (error.code === "PGRST205" ? "MISSING" : `present (${error.code})`) : "present"}`);
}
