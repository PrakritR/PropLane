import { createClient } from "@supabase/supabase-js";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!/emstjswhotsnyksqhqyf/.test(url ?? "")) throw new Error("dev/test only");
const db = createClient(url, key, { auth: { persistSession: false } });
const { data } = await db.from("manager_application_records")
  .select("resident_email,row_data->>bucket,row_data->>stage").eq("row_data->>bucket","pending").limit(10);
console.log("pending applicants:");
for (const a of data ?? []) console.log(`   ${a.resident_email}  stage=${a.stage}`);
const emails=(data??[]).map(a=>a.resident_email);
const { data: profs } = await db.from("profiles").select("email,role").in("email", emails);
console.log("have profiles (can sign in):", (profs??[]).map(p=>`${p.email}:${p.role}`).join(", ") || "none");
