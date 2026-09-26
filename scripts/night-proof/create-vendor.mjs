// Scratch proof helper (night/vendor-signup) — creates a fresh, pre-confirmed
// vendor account with NO manager link, mirroring a real public self-serve
// signup minus the email-confirmation round trip (RESEND_API_KEY sends to a
// test.proplane.local address that cannot actually be read).
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local" });

const email = process.argv[2];
const password = process.argv[3];
if (!email || !password) {
  console.error("usage: node scripts/night-proof/create-vendor.mjs <email> <password>");
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const { data: created, error: createErr } = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { role: "vendor" },
});
if (createErr) throw new Error(`createUser: ${createErr.message}`);
const userId = created.user.id;

const { error: profileErr } = await supabase
  .from("profiles")
  .upsert({ id: userId, email, role: "vendor", full_name: "Night Proof Vendor" }, { onConflict: "id" });
if (profileErr) throw new Error(`profiles upsert: ${profileErr.message}`);

console.log(JSON.stringify({ userId, email }));
