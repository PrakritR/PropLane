import { createClient } from "@supabase/supabase-js";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!/emstjswhotsnyksqhqyf/.test(url ?? "")) throw new Error("dev/test only");
const db = createClient(url, key, { auth: { persistSession: false } });
const email = "maya.chen.e2e@test.proplane.local";
const { data: prof } = await db.from("profiles").select("id,email,role,manager_id").eq("email", email);
console.log("profile:", JSON.stringify(prof));
const { data: roles } = await db.from("profile_roles").select("role").eq("user_id", prof?.[0]?.id ?? "00000000-0000-0000-0000-000000000000");
console.log("profile_roles:", JSON.stringify(roles));
const { data: charges } = await db.from("portal_household_charge_records")
  .select("id,resident_user_id,resident_email").eq("resident_email", email).limit(5);
console.log("charges by email:", JSON.stringify(charges));
