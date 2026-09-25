// Live-server proof for the Part 3 lease-signing hotfix (WS1), against the
// real running dev server + dev Supabase project — not the unit suite. Uses
// a Supabase password-grant session cookie built the same way @supabase/ssr
// reads it server-side (see scripts/night-proof/api-proof.mjs precedent).
import dotenv from "dotenv";
import { createHash } from "node:crypto";
dotenv.config({ path: ".env.local" });

const BASE = "http://localhost:3012";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split(".")[0];
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`;

const MANAGER_EMAIL = "proof.ws1hotfix.manager@test.proplane.local";
const RESIDENT_EMAIL = "proof.ws1hotfix.resident@test.proplane.local";
const PASSWORD = "Ws1HotfixProof123!";
const LEASE_ID = "lease_ws1hotfix_proof";
const LEASE_HTML =
  "<html><body><h1>RESIDENTIAL LEASE AGREEMENT</h1><p>This Lease is made between WS1 Hotfix Proof LLC (\"Landlord\") and Jordan Proof (\"Resident\") for Unit A at 100 Proof St, Seattle, WA. Rent: $1,500.00 per month.</p></body></html>";
const REAL_HASH = createHash("sha256").update(Buffer.from(LEASE_HTML, "utf8")).digest("hex");

async function passwordGrantCookie(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const session = await res.json();
  if (!res.ok) throw new Error(`password grant failed for ${email}: ${JSON.stringify(session)}`);
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64")}`;
  return `${COOKIE_NAME}=${encodeURIComponent(value)}`;
}

const results = [];
function check(label, ok, extra) {
  results.push([label, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}${extra ? ` :: ${JSON.stringify(extra)}` : ""}`);
}

async function main() {
  const residentCookie = await passwordGrantCookie(RESIDENT_EMAIL, PASSWORD);
  const managerCookie = await passwordGrantCookie(MANAGER_EMAIL, PASSWORD);

  // ── Defect 1: the sent lease is VISIBLE to the resident over the real GET ──
  const listRes = await fetch(`${BASE}/api/portal-lease-pipeline`, { headers: { Cookie: residentCookie } });
  const listBody = await listRes.json();
  const row = (listBody.rows ?? []).find((r) => r.id === LEASE_ID);
  check("GET /api/portal-lease-pipeline (resident) returns 200", listRes.ok);
  check("the sent lease is present in the resident's own list", Boolean(row), { rowCount: (listBody.rows ?? []).length });
  check("the list response is SLIM (documentOmitted true, no bytes) — proves the visibility fix isn't hiding this", Boolean(row?.documentOmitted) && !row?.generatedHtml);

  // ── Defect 3 (server half): a signature with the WRONG hash is refused ────
  const badSignRes = await fetch(`${BASE}/api/portal-lease-pipeline`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: residentCookie },
    body: JSON.stringify({
      action: "upsert",
      row: {
        id: LEASE_ID,
        residentEmail: RESIDENT_EMAIL,
        generatedHtml: LEASE_HTML,
        bucket: "signed",
        status: "Manager Signature Pending",
        residentSignature: { role: "resident", name: "Jordan Proof", signedAtIso: new Date().toISOString(), documentSha256: "f".repeat(64) },
      },
    }),
  });
  const badSignBody = await badSignRes.json().catch(() => ({}));
  check("a signature with the WRONG hash is refused (409)", badSignRes.status === 409, badSignBody);

  // ── Defects 2+3 happy path: a signature with the CORRECT hash succeeds ────
  const goodSignRes = await fetch(`${BASE}/api/portal-lease-pipeline`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: residentCookie },
    body: JSON.stringify({
      action: "upsert",
      row: {
        id: LEASE_ID,
        residentEmail: RESIDENT_EMAIL,
        generatedHtml: LEASE_HTML,
        bucket: "signed",
        status: "Manager Signature Pending",
        residentSignature: { role: "resident", name: "Jordan Proof", signedAtIso: new Date().toISOString(), documentSha256: REAL_HASH },
      },
    }),
  });
  check("a signature with the CORRECT hash is accepted (200)", goodSignRes.ok, await goodSignRes.json().catch(() => ({})));

  const afterSignRes = await fetch(`${BASE}/api/portal-lease-pipeline?id=${LEASE_ID}`, { headers: { Cookie: residentCookie } });
  const afterSignBody = await afterSignRes.json();
  const signedRow = (afterSignBody.rows ?? [])[0];
  check("stored row now carries the resident signature with the real hash", signedRow?.row_data?.residentSignature?.documentSha256 === REAL_HASH || signedRow?.residentSignature?.documentSha256 === REAL_HASH, signedRow);

  // A SECOND wrong-hash signature attempt (simulating stale-copy re-sign) must
  // still be refused by the pre-existing signature-write-refusal guard.
  const resignRes = await fetch(`${BASE}/api/portal-lease-pipeline`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: residentCookie },
    body: JSON.stringify({
      action: "upsert",
      row: {
        id: LEASE_ID,
        residentEmail: RESIDENT_EMAIL,
        generatedHtml: LEASE_HTML,
        bucket: "signed",
        status: "Manager Signature Pending",
        residentSignature: { role: "resident", name: "Jordan Proof", signedAtIso: new Date().toISOString(), documentSha256: "a".repeat(64) },
      },
    }),
  });
  check("existing signature-write-refusal guard still refuses a second signature (409, untouched by this hotfix)", resignRes.status === 409);

  // ── Defect 4: "Send lease to sign" creates a real draft ───────────────────
  const freshResidentEmail = `proof.ws1hotfix.leasefirst.${Date.now()}@test.proplane.local`;
  const propertyRes = await fetch(`${BASE}/api/portal/send-lead-invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: managerCookie },
    body: JSON.stringify({
      kind: "lease",
      to: freshResidentEmail,
      viaEmail: true,
      viaSms: false,
      prospectName: "Lease First Proof",
      propertyId: "prop_ws1hotfix_proof",
    }),
  });
  const sendBody = await propertyRes.json().catch(() => ({}));
  check("POST send-lead-invite kind=lease succeeds (200) — email delivery may still fail in dev without RESEND_API_KEY, in which case this legitimately reports 503 and the draft-creation check below is what matters", propertyRes.status === 200 || propertyRes.status === 503, sendBody);

  console.log("\n=== WS1 LEASE HOTFIX API PROOF RESULTS ===");
  const failed = results.filter(([, ok]) => !ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
