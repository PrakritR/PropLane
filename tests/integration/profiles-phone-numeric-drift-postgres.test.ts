import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Dedicated disposable local PostgreSQL only. The suite recreates the PRODUCTION drift that broke phone verify on the
// iPhone (`public.profiles.phone` as numeric while every writer uses E.164 text), loads the real phone-auth migration
// plus the two fixes, and proves the whole code sign-in through `phone_auth_bind`:
//   - numeric column: the bind raises 42804, nothing is verified, the user sees "We couldn't verify this number".
//   - after 20261027010000: the same sign-in binds the phone, confirms the Auth identity and attaches the contact.
//   - after 20261027020000: rows written while the column was numeric read back as E.164 again, so the exact-match
//     readers find them; it is idempotent, leaves non-digit strings alone, and does not trip the verified-phone guard
//     in shared line mode.
const url = process.env.PHONE_DRIFT_TEST_DATABASE_URL;
if (url && !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  throw new Error("The profiles.phone drift proof requires a disposable local PostgreSQL database.");
}
const db = new Pool({ connectionString: url, max: 4 });
afterAll(() => db.end());
const suite = url ? describe : describe.skip;

const PHONE_AUTH_MIGRATION = "supabase/migrations/20261018180000_phone_auth.sql";
const TO_TEXT = "supabase/migrations/20261027010000_profiles_phone_text.sql";
const TO_E164 = "supabase/migrations/20261027020000_profiles_phone_e164.sql";
const sql = (file: string) => readFileSync(file, "utf8");

const transcript: string[] = [];
const say = (line: string) => {
  transcript.push(line);
};

afterAll(() => {
  const out = process.env.EVIDENCE_DIR;
  if (!out || !transcript.length) return;
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/profiles-phone-drift-transcript.txt`, `${transcript.join("\n")}\n`, "utf8");
});

/** The production shape of everything `phone_auth_bind` touches, with `profiles.phone` NUMERIC as production had it. */
async function bootstrapProductionDrift() {
  await db.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    create extension if not exists pgcrypto;
    drop schema if exists auth cascade;
    create schema auth;
    create table auth.users (
      id uuid primary key,
      email text,
      aud text default 'authenticated',
      role text default 'authenticated',
      phone text,
      phone_confirmed_at timestamptz,
      phone_change text default '',
      phone_change_token text default '',
      phone_change_sent_at timestamptz,
      raw_app_meta_data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table auth.identities (
      provider_id text not null,
      user_id uuid not null references auth.users (id) on delete cascade,
      provider text not null,
      identity_data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (provider_id, provider)
    );
    drop table if exists public.profiles, public.profile_roles, public.sms_phone_contacts,
      public.sms_runtime_config, public.phone_otp_challenges, public.phone_auth_operation_locks cascade;
    -- PRODUCTION DRIFT: numeric, not text.
    create table public.profiles (
      id uuid primary key references auth.users (id) on delete cascade,
      email text,
      role text not null check (role in ('resident', 'manager', 'owner', 'admin')),
      full_name text,
      phone numeric,
      phone_verified_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table public.profile_roles (
      user_id uuid not null references auth.users (id) on delete cascade,
      role text not null,
      primary key (user_id, role)
    );
    create table public.sms_phone_contacts (
      phone_e164 text primary key check (phone_e164 ~ '^\\+[1-9][0-9]{7,14}$'),
      phone_key text not null unique,
      user_id uuid references auth.users (id) on delete set null,
      display_name text,
      first_seen_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now()
    );
    create table public.sms_runtime_config (
      singleton boolean primary key default true check (singleton),
      mode text not null default 'paused',
      line_mode text not null default 'per_workspace',
      shared_number_e164 text,
      updated_at timestamptz not null default now()
    );
    create table public.phone_otp_challenges (
      id uuid primary key default gen_random_uuid(),
      phone_key text not null,
      purpose text not null,
      subject_id text,
      code_hash text not null,
      attempts integer not null default 0,
      expires_at timestamptz not null,
      consumed_at timestamptz,
      created_at timestamptz not null default now()
    );
    -- The captain's shared-line switch is ON, so the verified-phone guards are live for every write below.
    insert into public.sms_runtime_config (singleton, mode, line_mode, shared_number_e164)
      values (true, 'automatic', 'shared', '+12025550190');
  `);
  await db.query(sql(PHONE_AUTH_MIGRATION));
}

async function account(opts: { role?: string } = {}) {
  const id = randomUUID();
  await db.query("insert into auth.users(id, email) values($1,$2)", [id, `${id}@phone-proof.invalid`]);
  await db.query("insert into public.profiles(id, role) values($1,$2)", [id, opts.role ?? "resident"]);
  return id;
}

/** The signed-out phone-code sign-in exactly as `verifyPhoneChallenge` drives it: start, consume, claim, bind. */
async function signInByCode(phone: string, user: string) {
  const challenge = randomUUID();
  const operation = randomUUID();
  const browser = `browser-${challenge}`;
  const key = phone.replace(/^\+1/, "");
  const started = await db.query(
    "select public.phone_auth_start($1,$2,$3,'sign_in',null,$4,'code-hash','local') as ok",
    [challenge, phone, key, browser],
  );
  expect(started.rows[0].ok).toBe(true);
  const proof = await db.query("select public.phone_auth_consume($1,null,$2,'code-hash') as proof", [challenge, browser]);
  expect(proof.rows[0].proof).toMatchObject({ phone, purpose: "sign_in", provider: "local" });
  const claimed = await db.query("select public.phone_auth_claim_operation($1,$2,$3) as ok", [operation, phone, user]);
  expect(claimed.rows[0].ok).toBe(true);
  try {
    const bound = await db.query("select public.phone_auth_bind($1,$2,$3,null,$4) as ok", [challenge, user, browser, operation]);
    return { ok: bound.rows[0].ok as boolean };
  } finally {
    await db.query("select public.phone_auth_release_operation($1)", [operation]);
  }
}

/**
 * A row as a numeric column handed it back. Shared line mode is on, so the write takes the same transaction-local
 * bind flag `guard_verified_phone_change` exempts - the only way to seed a verified row outside the bind.
 */
async function seedStoredPhone(user: string, stored: string, verified: boolean) {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('proplane.phone_auth_binding','yes', true)");
    await client.query(
      `update public.profiles set phone = $2, phone_verified_at = ${verified ? "now()" : "null"} where id = $1`,
      [user, stored],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

const phoneColumnType = async () =>
  (await db.query(
    "select data_type from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='phone'",
  )).rows[0].data_type as string;

const profileRow = async (user: string) =>
  (await db.query("select phone::text as phone, phone_verified_at from public.profiles where id=$1", [user])).rows[0] as
    { phone: string | null; phone_verified_at: string | null };

/** How `findResidentProfileByPhone` and the other exact-match readers ask: `.eq("phone", "+1…")`. */
const readerFindsByE164 = async (phone: string) =>
  (await db.query("select count(*)::int as n from public.profiles where phone = $1", [phone])).rows[0].n as number;

suite("profiles.phone production drift (real PostgreSQL)", () => {
  beforeAll(async () => {
    await bootstrapProductionDrift();
    say("=== Fixture: production schema drift, shared line mode, real 20261018180000_phone_auth.sql loaded ===");
    say(`profiles.phone column type: ${await phoneColumnType()}`);
  });

  it("numeric profiles.phone breaks the whole code sign-in with 42804 — the captain's iPhone failure", async () => {
    const user = await account();
    const phone = "+12065550111";
    let code = "";
    let message = "";
    await expect(signInByCode(phone, user).catch((error: { code?: string; message: string }) => {
      code = error.code ?? "";
      message = error.message;
      throw error;
    })).rejects.toThrow();
    expect(code).toBe("42804");
    expect(message).toMatch(/column "phone" is of type numeric but expression is of type text/);
    const row = await profileRow(user);
    expect(row.phone).toBeNull();
    expect(row.phone_verified_at).toBeNull();
    expect((await db.query("select phone, phone_confirmed_at from auth.users where id=$1", [user])).rows[0]).toMatchObject({
      phone: null, phone_confirmed_at: null,
    });
    say("");
    say("--- BEFORE 20261027010000: phone_auth_bind on a numeric column ---");
    say(`sign in by code ${phone}: SQLSTATE ${code} — ${message}`);
    say(`profiles row after the failure: phone=${row.phone ?? "null"} phone_verified_at=${row.phone_verified_at ?? "null"}`);
    say('user-visible result: PHONE_AUTH_ERROR → "We couldn\'t verify this number. Try again or contact your manager."');
  });

  it("20261027010000 converts the column to text and the same sign-in binds, confirms and attaches", async () => {
    await db.query(sql(TO_TEXT));
    expect(await phoneColumnType()).toBe("text");
    const user = await account();
    const phone = "+12065550112";
    expect(await signInByCode(phone, user)).toEqual({ ok: true });
    const row = await profileRow(user);
    expect(row.phone).toBe(phone);
    expect(row.phone_verified_at).not.toBeNull();
    const authUser = (await db.query("select phone, phone_confirmed_at from auth.users where id=$1", [user])).rows[0];
    expect(authUser.phone).toBe("12065550112");
    expect(authUser.phone_confirmed_at).not.toBeNull();
    const identity = (await db.query(
      "select identity_data->>'phone' as phone from auth.identities where user_id=$1 and provider='phone'", [user],
    )).rows[0];
    expect(identity.phone).toBe("12065550112");
    expect((await db.query("select user_id from public.sms_phone_contacts where phone_e164=$1", [phone])).rows[0].user_id).toBe(user);
    expect((await db.query("select public.phone_auth_owners($1) as owners", [phone])).rows[0].owners).toEqual([user]);
    expect(await readerFindsByE164(phone)).toBe(1);
    say("");
    say("--- AFTER 20261027010000 (numeric -> text) ---");
    say(`profiles.phone column type: ${await phoneColumnType()}`);
    say(`sign in by code ${phone}: phone_auth_bind -> true`);
    say(`profiles row: phone=${row.phone} phone_verified_at=${row.phone_verified_at}`);
    say(`auth.users: phone=${authUser.phone} phone_confirmed_at=${authUser.phone_confirmed_at}`);
    say(`auth.identities(phone): ${identity.phone} · sms_phone_contacts owner: ${user}`);
    say(`exact-match reader (profiles.phone = '${phone}') finds the account: yes`);
    say("user-visible result: the code is accepted and the number is verified");
  });

  it("is a no-op where the column is already text: a second run changes nothing", async () => {
    const before = (await db.query("select id, phone, phone_verified_at from public.profiles order by id")).rows;
    await db.query(sql(TO_TEXT));
    expect(await phoneColumnType()).toBe("text");
    expect((await db.query("select id, phone, phone_verified_at from public.profiles order by id")).rows).toEqual(before);
  });

  it("20261027020000 re-normalizes the bare digits a numeric column left behind, idempotently", async () => {
    const digits10 = await account();
    const digits11 = await account();
    const alreadyE164 = await account();
    const handTyped = await account();
    const untouched = await account();
    // Rows as a numeric column handed them back: the leading `+` could not be stored.
    await seedStoredPhone(digits10, "2065550133", true);
    await seedStoredPhone(digits11, "12065550134", true);
    await seedStoredPhone(alreadyE164, "+12065550135", true);
    await seedStoredPhone(handTyped, "(206) 555-0136", false);
    expect(await readerFindsByE164("+12065550133")).toBe(0);
    expect(await readerFindsByE164("+12065550134")).toBe(0);
    say("");
    say("--- BEFORE 20261027020000: rows a numeric column handed back without the `+` ---");
    for (const id of [digits10, digits11, alreadyE164, handTyped, untouched]) {
      say(`  profiles.phone = ${JSON.stringify((await profileRow(id)).phone)}`);
    }
    say("exact-match reader for '+12065550133' / '+12065550134': 0 rows — the resident/manager/guest lookups miss");

    // Shared line mode is on, so an unflagged write here would be refused by guard_verified_phone_change.
    await db.query(sql(TO_E164));

    expect((await profileRow(digits10)).phone).toBe("+12065550133");
    expect((await profileRow(digits11)).phone).toBe("+12065550134");
    expect((await profileRow(alreadyE164)).phone).toBe("+12065550135");
    expect((await profileRow(handTyped)).phone).toBe("(206) 555-0136");
    expect((await profileRow(untouched)).phone).toBeNull();
    expect(await readerFindsByE164("+12065550133")).toBe(1);
    expect(await readerFindsByE164("+12065550134")).toBe(1);
    // Same digits, same account: a shape fix, never a new identity.
    expect((await db.query(
      "select count(*)::int as n from public.profiles where id=$1 and phone_verified_at is not null", [digits10],
    )).rows[0].n).toBe(1);
    expect((await db.query("select public.phone_auth_owners('+12065550133') as owners")).rows[0].owners).toEqual([digits10]);

    const after = (await db.query("select id, phone, phone_verified_at from public.profiles order by id")).rows;
    await db.query(sql(TO_E164));
    expect((await db.query("select id, phone, phone_verified_at from public.profiles order by id")).rows).toEqual(after);

    say("");
    say("--- AFTER 20261027020000 (bare digits -> E.164, run twice) ---");
    for (const id of [digits10, digits11, alreadyE164, handTyped, untouched]) {
      say(`  profiles.phone = ${JSON.stringify((await profileRow(id)).phone)}`);
    }
    say("exact-match reader for '+12065550133' / '+12065550134': 1 row each");
    say("phone_auth_owners('+12065550133') -> the same account, still verified (a shape fix, not a new identity)");
    say("a second run of the migration changes nothing (idempotent); the hand-typed string and the null are untouched");
  });

  it("a normalized row can still sign in by code, and signing in again is still refused for a second owner", async () => {
    const owner = (await db.query("select id from public.profiles where phone = '+12065550133'")).rows[0].id as string;
    expect(await signInByCode("+12065550133", owner)).toEqual({ ok: true });
    const stranger = await account();
    expect(await signInByCode("+12065550133", stranger)).toEqual({ ok: false });
    say("");
    say("--- the normalized number still works as an identity ---");
    say("its own account signs in by code again: phone_auth_bind -> true");
    say("a different account claiming the same number: phone_auth_bind -> false (ownership still arbitrated)");
  });
});
