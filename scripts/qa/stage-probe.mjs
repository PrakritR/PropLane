import { createClient } from "@supabase/supabase-js";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!/emstjswhotsnyksqhqyf/.test(url)) throw new Error("dev/test only — refusing");
const db = createClient(url, key, { auth: { persistSession: false } });
const email = process.env.E2E_RESIDENT_EMAIL || "resident@test.axis.local";
const { data: apps } = await db.from("manager_application_records")
  .select("id,manager_user_id,resident_email,row_data->>bucket,row_data->>stage").eq("resident_email", email).limit(10);
console.log("applications for", email);
for (const a of apps ?? []) console.log(`  ${a.id}  mgr=${a.manager_user_id?.slice(0,8)}  bucket=${a.bucket}  stage=${a.stage}`);
const { data: drift } = await db.from("manager_application_records")
  .select("id,resident_email,row_data->>email,row_data->>bucket").limit(400);
const mine = (drift ?? []).filter(r => (r.email||"").toLowerCase() === email.toLowerCase());
console.log("rows whose row_data.email matches but column may not:", mine.length);
for (const m of mine.slice(0,5)) console.log(`   ${m.id}  column=${m.resident_email}  row_data=${m.email}  bucket=${m.bucket}`);
const byBucket = {};
for (const r of drift ?? []) byBucket[r.bucket ?? "?"] = (byBucket[r.bucket ?? "?"] || 0) + 1;
console.log("all applications by bucket:", JSON.stringify(byBucket));
const emails = [...new Set((drift??[]).map(r=>r.resident_email).filter(Boolean))].slice(0,8);
console.log("sample applicant emails:", emails.join(", "));
const { data: leases } = await db.from("portal_lease_pipeline_records")
  .select("id,manager_user_id,resident_email,row_data->>status").eq("resident_email", email).limit(10);
console.log("leases:", (leases ?? []).map(l => `${l.id}:${l.status}`).join(", ") || "none");
