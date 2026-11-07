/** Exact existing DEV fixtures only. Synthetic seeded state, never SMS proof. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { connectNonproductionDatabase, nonproductionDatabaseConfig } from "../../scripts/security/nonproduction-database.mjs";

export const CANONICAL_PHONE_FIXTURES = Object.freeze([
  { label: "manager2", email: "manager2@test.proplane.local", axisId: "MGR-TESTE2E2", role: "manager", phone: "+12025550131" },
  { label: "marcus", email: "marcus.chen.workflow@test.proplane.local", axisId: "AXIS-DEMMARCUSC", role: "resident", phone: "+12025550132" },
  { label: "jordan", email: "jordan.lee.workflow@test.proplane.local", axisId: "AXIS-DEMOJORDL", role: "resident", phone: "+12025550133" },
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function validateCanonicalPhoneInput({ url, expectedIds, apply, env = process.env }) {
  if (url !== "https://emstjswhotsnyksqhqyf.supabase.co") throw new Error("Canonical phone preparation requires exact DEV URL.");
  for (const [key, expected] of [["E2E_MANAGER2_EMAIL", CANONICAL_PHONE_FIXTURES[0].email]]) {
    if (env[key]?.trim() && env[key].trim().toLowerCase() !== expected) throw new Error("Noncanonical fixture override refused.");
  }
  if (apply && (!expectedIds || Object.keys(expectedIds).length !== 3 ||
    CANONICAL_PHONE_FIXTURES.some(({ label }) => !UUID.test(expectedIds[label] ?? "")) ||
    new Set(Object.values(expectedIds)).size !== 3)) throw new Error("Apply requires the reviewed exact three fixture IDs.");
}

export async function prepareCanonicalPhonePrerequisites(db, options) {
  validateCanonicalPhoneInput(options);
  const { apply = false, expectedIds, expectedPhoneDigests } = options;
  try {
    await db.query(apply ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN READ ONLY");
    await db.query("SET LOCAL ROLE postgres");
    await db.query("SET LOCAL statement_timeout='10s'");
    await db.query("SET LOCAL lock_timeout='5s'");
    const inventory = [];
    // Complete inventory and collision checks for every actor before any write.
    for (const fixture of CANONICAL_PHONE_FIXTURES) {
      const result = await db.query(`select p.id::text,p.email,p.manager_id,p.role,p.phone,p.phone_verified_at,
        u.email as auth_email,u.phone as auth_phone,u.phone_confirmed_at,
        (select array_agg(role order by role) from public.profile_roles where user_id=p.id) as roles
        from public.profiles p join auth.users u on u.id=p.id where lower(p.email)=$1`, [fixture.email]);
      const row = result.rows[0];
      if (result.rows.length !== 1 || !UUID.test(row?.id ?? "") || row.email !== fixture.email ||
        row.auth_email !== fixture.email || row.manager_id !== fixture.axisId || row.role !== fixture.role ||
        JSON.stringify(row.roles) !== JSON.stringify([fixture.role]) || (expectedIds && expectedIds[fixture.label] !== row.id)) {
        throw new Error(`Canonical ${fixture.label} identity mismatch.`);
      }
      const phones = await db.query(`select public.phone_auth_e164($1::text) as profile_phone,
        public.phone_auth_e164('+' || ltrim(coalesce($2::text,''),'+')) as auth_phone`, [row.phone, row.auth_phone]);
      const current = phones.rows[0];
      const phoneDigest = createHash("sha256").update(JSON.stringify(row.phone ?? null)).digest("hex");
      const replacingUnverified = Boolean(row.phone && current.profile_phone !== fixture.phone);
      if ((replacingUnverified && row.phone_verified_at) || (row.auth_phone && current.auth_phone !== fixture.phone)) {
        throw new Error(`Canonical ${fixture.label} has another bound phone; refusing replacement.`);
      }
      if (apply && replacingUnverified && expectedPhoneDigests?.[fixture.label] !== phoneDigest) {
        throw new Error(`Canonical ${fixture.label} unverified phone drift requires its reviewed digest.`);
      }
      if (apply) {
        await db.query("select pg_advisory_xact_lock(hashtextextended('phone-auth-user:' || $1,0))", [row.id]);
        await db.query("select pg_advisory_xact_lock(hashtextextended('phone-auth:' || $1,0))", [fixture.phone]);
      }
      const conflicts = await db.query(`select
        (select count(*)::int from public.profiles where id<>$2::uuid and public.phone_auth_e164(phone::text)=$1) as profiles,
        (select count(*)::int from auth.users where id<>$2::uuid and public.phone_auth_e164('+' || ltrim(coalesce(phone,''),'+'))=$1) as auth,
        (select count(*)::int from public.sms_phone_contacts where phone_e164=$1 and user_id is distinct from $2::uuid) as contacts,
        (select count(*)::int from public.sms_phone_contacts where user_id=$2::uuid and phone_e164<>$1) as other_contacts,
        (select count(*)::int from public.phone_auth_operation_locks where key in ('phone:' || $1,'phone:' || coalesce($3::text,''),'user:' || $2) and expires_at>now()) as operations`, [fixture.phone, row.id, current.profile_phone]);
      if (Object.values(conflicts.rows[0]).some((count) => count !== 0)) throw new Error(`Canonical ${fixture.label} phone collision or active operation.`);
      inventory.push({ fixture, id: row.id, priorPhone: row.phone ?? null, phoneDigest, replacingUnverified, ready: Boolean(row.phone_verified_at && current.profile_phone === fixture.phone) });
    }
    if (apply) {
      await db.query("select set_config('proplane.phone_auth_binding','yes',true)");
      for (const { fixture, id, ready, priorPhone } of inventory) {
        if (ready) continue;
        const updated = await db.query(`update public.profiles set phone=$1,phone_verified_at=now(),updated_at=now()
          where id=$2::uuid and email=$3 and manager_id=$4 and role=$5
          and phone is not distinct from $6::text returning id`, [fixture.phone, id, fixture.email, fixture.axisId, fixture.role, priorPhone]);
        if (updated.rowCount !== 1) throw new Error(`Canonical ${fixture.label} phone write did not match exactly one profile.`);
      }
      const readback = await db.query(`select id::text,public.phone_auth_e164(phone::text) as phone,
        phone_verified_at is not null as verified from public.profiles where id=any($1::uuid[])`, [inventory.map(({ id }) => id)]);
      if (inventory.some(({ id, fixture }) => !readback.rows.some((row) => row.id === id && row.phone === fixture.phone && row.verified))) throw new Error("Canonical phone readback failed.");
      await db.query("COMMIT");
    } else await db.query("ROLLBACK");
    return { syntheticSeedOnly: true, applied: apply, fixtures: inventory.map(({ fixture, ready, phoneDigest, replacingUnverified }) => ({ label: fixture.label, phoneDigest, replacingUnverified, readyBefore: ready, readyAfter: apply || ready })) };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
export async function runCanonicalPhonePreparation(args = process.argv.slice(2)) {
  const allowed = new Set(["--phone-prerequisites", "--apply", "--expected-ids-file"]);
  const fileIndex = args.indexOf("--expected-ids-file");
  if (args.some((arg, index) => !allowed.has(arg) && !(fileIndex >= 0 && index === fileIndex + 1))) throw new Error("Unsupported canonical phone preparation argument.");
  const reviewed = fileIndex >= 0 ? JSON.parse(readFileSync(args[fileIndex + 1], "utf8")) : undefined;
  const options = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, apply: args.includes("--apply"), expectedIds: reviewed?.ids ?? reviewed, expectedPhoneDigests: reviewed?.phoneDigests };
  validateCanonicalPhoneInput(options);
  const db = await connectNonproductionDatabase(nonproductionDatabaseConfig("emstjswhotsnyksqhqyf"));
  try { console.log(JSON.stringify(await prepareCanonicalPhonePrerequisites(db, options))); }
  finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCanonicalPhonePreparation().catch(() => { console.error("Canonical phone preparation failed; inspect the private reviewed inventory."); process.exitCode = 1; });
}
