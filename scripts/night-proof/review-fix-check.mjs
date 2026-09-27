// Quick real-server sanity check after the review-fix (hasRole/getPortalAccessContext
// instead of profiles.role) — confirms the manager directory routes still work
// end to end for a real manager account against the live dev database.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "http://localhost:3012";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split(".")[0];
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`;

async function sessionCookie(email, password) {
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

const managerCookie = await sessionCookie("manager@test.proplane.local", "TestManager123!");
const residentCookie = await sessionCookie("resident@test.proplane.local", "TestResident123!");

const managerRes = await fetch(`${BASE}/api/manager/vendor-directory`, { headers: { Cookie: managerCookie } });
console.log("manager GET /api/manager/vendor-directory:", managerRes.status, managerRes.status === 200 ? "PASS" : "FAIL");

const residentRes = await fetch(`${BASE}/api/manager/vendor-directory`, { headers: { Cookie: residentCookie } });
console.log("resident GET /api/manager/vendor-directory:", residentRes.status, residentRes.status === 403 ? "PASS" : "FAIL");

const addRes = await fetch(`${BASE}/api/manager/vendor-directory/add`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: residentCookie },
  body: JSON.stringify({ vendorUserId: "does-not-matter" }),
});
console.log("resident POST /api/manager/vendor-directory/add:", addRes.status, addRes.status === 403 ? "PASS" : "FAIL");
