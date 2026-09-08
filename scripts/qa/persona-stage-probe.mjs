import { createClient } from "@supabase/supabase-js";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!/emstjswhotsnyksqhqyf/.test(url ?? "")) throw new Error("dev/test only");
const db = createClient(url, key, { auth: { persistSession: false } });
const { data: apps } = await db.from("manager_application_records")
  .select("resident_email,row_data->>bucket,row_data->>stage").in("row_data->>bucket", ["approved"]).limit(20);
console.log("approved applicants:");
for (const a of apps ?? []) console.log(`   ${a.resident_email}  stage=${a.stage}`);
const emails = [...new Set((apps ?? []).map(a => a.resident_email))];
const { data: leases } = await db.from("portal_lease_pipeline_records")
  .select("resident_email,row_data->>status").in("resident_email", emails).limit(20);
console.log("\nleases for those applicants:");
for (const l of leases ?? []) console.log(`   ${l.resident_email}  status=${l.status}`);
if (!leases?.length) console.log("   (none — so approved personas sit at post_approval_pre_lease)");
