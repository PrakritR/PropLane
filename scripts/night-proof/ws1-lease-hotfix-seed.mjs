// Throwaway proof seed for the Part 3 lease-signing hotfix (WS1). Creates a
// fresh manager+resident pair, one property, and a lease sent to the
// resident (Resident Signature Pending) with a real generated document — so
// the live server can be proven end to end, not just the unit suite.
// Refuses to run against anything but dev/test. Never touches production.
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

dotenv.config({ path: ".env.local" });

const DEV_REF = "emstjswhotsnyksqhqyf";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const ref = new URL(url).hostname.split(".")[0];
if (ref !== DEV_REF) {
  console.error(`Refusing to seed: expected dev project ${DEV_REF}, got ${ref}.`);
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const PASSWORD = "Ws1HotfixProof123!";
const MANAGER_EMAIL = "proof.ws1hotfix.manager@test.proplane.local";
const RESIDENT_EMAIL = "proof.ws1hotfix.resident@test.proplane.local";
const PROPERTY_ID = "prop_ws1hotfix_proof";
const LEASE_ID = "lease_ws1hotfix_proof";

export const LEASE_HTML =
  "<html><body><h1>RESIDENTIAL LEASE AGREEMENT</h1><p>This Lease is made between WS1 Hotfix Proof LLC (\"Landlord\") and Jordan Proof (\"Resident\") for Unit A at 100 Proof St, Seattle, WA. Rent: $1,500.00 per month.</p></body></html>";
export const LEASE_HTML_SHA256 = createHash("sha256").update(Buffer.from(LEASE_HTML, "utf8")).digest("hex");

async function findOrCreateUser(email, name, role) {
  let page = 1;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const existing = data.users.find((u) => u.email?.toLowerCase() === email);
    if (existing) return existing.id;
    if (data.users.length < 200) break;
    page += 1;
  }
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: name },
  });
  if (createErr) throw createErr;
  return created.user.id;
}

async function main() {
  const managerId = await findOrCreateUser(MANAGER_EMAIL, "WS1 Hotfix Proof Manager", "manager");
  const residentId = await findOrCreateUser(RESIDENT_EMAIL, "Jordan Proof", "resident");

  await supabase.from("profiles").upsert(
    [
      { id: managerId, email: MANAGER_EMAIL, role: "manager", full_name: "WS1 Hotfix Proof Manager" },
      { id: residentId, email: RESIDENT_EMAIL, role: "resident", full_name: "Jordan Proof" },
    ],
    { onConflict: "id" },
  );
  await supabase.from("profile_roles").upsert(
    [
      { user_id: managerId, role: "manager" },
      { user_id: residentId, role: "resident" },
    ],
    { onConflict: "user_id,role" },
  );

  await supabase.from("manager_property_records").upsert(
    {
      id: PROPERTY_ID,
      manager_user_id: managerId,
      status: "live",
      property_data: {
        id: PROPERTY_ID,
        title: "WS1 Hotfix Proof House",
        address: "100 Proof St, Seattle, WA",
        listingSubmission: { rooms: [{ id: "r1", monthlyRent: 1500 }] },
        published: true,
        adminPublishLive: true,
      },
    },
    { onConflict: "id" },
  );

  // A lease already SENT to the resident (Resident Signature Pending),
  // exactly the shape the resident's own Lease tab must show (defect 1) and
  // that residentSignLease must be able to load and hash (defects 2/3).
  const iso = new Date().toISOString();
  await supabase.from("portal_lease_pipeline_records").upsert(
    {
      id: LEASE_ID,
      manager_user_id: managerId,
      resident_user_id: residentId,
      resident_email: RESIDENT_EMAIL,
      property_id: PROPERTY_ID,
      status: "resident",
      row_data: {
        id: LEASE_ID,
        residentName: "Jordan Proof",
        residentEmail: RESIDENT_EMAIL,
        unit: "Unit A",
        bucket: "resident",
        status: "Resident Signature Pending",
        pdfVersion: 1,
        notes: "",
        updatedAtIso: iso,
        propertyId: PROPERTY_ID,
        managerUserId: managerId,
        residentUserId: residentId,
        generatedHtml: LEASE_HTML,
        generatedAtIso: iso,
        sentToResidentAt: iso,
        thread: [],
      },
      updated_at: iso,
    },
    { onConflict: "id" },
  );

  console.log("SEEDED");
  console.log(JSON.stringify({ managerId, residentId, MANAGER_EMAIL, RESIDENT_EMAIL, PASSWORD, LEASE_ID, PROPERTY_ID, LEASE_HTML_SHA256 }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
