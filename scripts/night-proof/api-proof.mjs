// Night build proof (night/vendor-signup), fallback path: the machine is
// running six concurrent dev-server lanes (load average ~20-26) and full
// browser automation kept stalling on cold compiles well past reasonable
// waits, even after retries. This proves the SAME feature surfaces via real
// authenticated HTTP against the running dev server (no browser), using a
// Supabase password-grant session cookie built the same way @supabase/ssr
// reads it server-side. `/vendor/onboarding` and the manager PropLane
// vendors tab were still verified visually — see the *.png screenshots that
// DID complete before the machine-load fallback; this script covers what a
// full click-through could not finish in time.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "http://localhost:3012";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split(".")[0];
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`;

async function passwordGrantCookie(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const session = await res.json();
  if (!res.ok) throw new Error(`password grant failed: ${JSON.stringify(session)}`);
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64")}`;
  return `${COOKIE_NAME}=${encodeURIComponent(value)}`;
}

const results = [];
function check(label, ok) {
  results.push([label, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
}

async function main() {
  const vendorEmail = process.argv[2] || "night-vendor-signup-3@test.proplane.local";
  const vendorPassword = process.argv[3] || "NightVendor123!";
  const vendorCookie = await passwordGrantCookie(vendorEmail, vendorPassword);
  const managerCookie = await passwordGrantCookie("manager@test.proplane.local", "TestManager123!");

  // ── Vendor: complete onboarding via the real API ──────────────────────────
  const patchRes = await fetch(`${BASE}/api/vendor/business-profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: vendorCookie },
    body: JSON.stringify({
      businessName: "Night Proof Plumbing LLC",
      trades: ["Plumbing"],
      serviceArea: "Seattle, WA",
      serviceAreaZips: ["98101"],
      serviceRadiusMiles: 20,
      licenseNumber: "WA-NIGHT-12345",
      insuranceProvider: "Harbor Mutual",
      insurancePolicyNumber: "HM-000999",
      directoryListed: true,
    }),
  });
  const patchBody = await patchRes.json();
  check("PATCH /api/vendor/business-profile saves onboarding fields (200)", patchRes.ok);
  check("onboardingCompletedAt set after required fields filled", Boolean(patchBody.profile?.onboardingCompletedAt));
  check("directoryListed true", patchBody.profile?.directoryListed === true);

  const getRes = await fetch(`${BASE}/api/vendor/business-profile`, { headers: { Cookie: vendorCookie } });
  const getBody = await getRes.json();
  check("GET /api/vendor/business-profile reads back the same saved profile", getBody.profile?.businessName === "Night Proof Plumbing LLC");

  const profileRes = await fetch(`${BASE}/api/vendor/profile`, { headers: { Cookie: vendorCookie } });
  const profileBody = await profileRes.json();
  check("vendor is unlinked before any manager adds them (drives the dashboard banner)", profileBody.linked === false);

  // ── Manager: find in directory, filter, add ───────────────────────────────
  const dirRes = await fetch(`${BASE}/api/manager/vendor-directory?trade=${encodeURIComponent("Plumbing")}`, {
    headers: { Cookie: managerCookie },
  });
  const dirBody = await dirRes.json();
  const found = (dirBody.rows ?? []).find((r) => r.name === "Night Proof Plumbing LLC");
  check("manager directory search (trade=Plumbing) finds the self-serve vendor", Boolean(found));
  check("directory row exposes only public-safe fields (no email/phone/policy/doc path)", (() => {
    if (!found) return false;
    const serialized = JSON.stringify(found);
    return (
      found.email === "" &&
      found.phone === "" &&
      !serialized.includes("HM-000999") &&
      !("insurancePolicyNumber" in found) &&
      !("licenseDocPath" in found)
    );
  })());
  // licensed derives from the license NUMBER (provided above, so true); insured
  // requires an uploaded, non-expired certificate — never provided here, so false.
  check("directory row derives licensed from license number, insured from an uploaded certificate", found ? found.licensed === true && found.insured === false : false);

  const addRes = await fetch(`${BASE}/api/manager/vendor-directory/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: managerCookie },
    body: JSON.stringify({ vendorUserId: found?.directoryVendorUserId }),
  });
  const addBody = await addRes.json();
  check("POST add-to-roster links the vendor (existing:false on first call)", addRes.ok && addBody.existing === false);
  check("linked roster row carries the real vendor_user_id link", addBody.row?.vendorUserId === found?.directoryVendorUserId);

  const addAgainRes = await fetch(`${BASE}/api/manager/vendor-directory/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: managerCookie },
    body: JSON.stringify({ vendorUserId: found?.directoryVendorUserId }),
  });
  const addAgainBody = await addAgainRes.json();
  check("add-to-roster is idempotent (existing:true on the second call, same row id)",
    addAgainRes.ok && addAgainBody.existing === true && addAgainBody.row?.id === addBody.row?.id);

  // ── Vendor: banner clears now that they're linked ─────────────────────────
  const profileAfterRes = await fetch(`${BASE}/api/vendor/profile`, { headers: { Cookie: vendorCookie } });
  const profileAfterBody = await profileAfterRes.json();
  check("vendor now shows linked:true (dashboard banner disappears)", profileAfterBody.linked === true);

  console.log("\n=== API PROOF RESULTS ===");
  const failed = results.filter(([, ok]) => !ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
