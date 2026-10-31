/**
 * `scripts/one-shot/bind-existing-resident-subjects-20261030.sql` is the release's only way to give a
 * pre-release resident row the Auth subject the new reads scope on: 20261030144600 adds the column
 * with no backfill and its trigger raises 'Existing service subject cannot be assigned' on any UPDATE
 * that would set one. The 16 migrations are approved as applied, so this is a script, not a 17th.
 *
 * There is no local-postgres harness in this repo (every other migration here is pinned statically —
 * see `move-in-form-subject-migration.test.ts`), so this pins the guards the script must not lose:
 * one transaction, proof-based subject selection, still-null-guarded updates, the guard trigger
 * disabled for exactly the two service tables and re-enabled before commit, and a preview + a
 * verification section so a dry run is readable.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PATH = "scripts/one-shot/bind-existing-resident-subjects-20261030.sql";
const sql = readFileSync(PATH, "utf8");
/** Index of a statement on its own line, so a mention of it in the header comment never matches. */
const stmt = (keyword: string) => sql.search(new RegExp(`^${keyword};$`, "m"));
const BEGIN = stmt("begin");
const COMMIT = stmt("commit");

describe("the resident-subject backfill is one guarded transaction", () => {
  it("opens exactly one transaction and commits once", () => {
    expect(sql.match(/^begin;$/gm)).toHaveLength(1);
    expect(sql.match(/^commit;$/gm)).toHaveLength(1);
    // No partial commit in the middle, and no rollback left in the committed file.
    expect(BEGIN).toBeGreaterThan(-1);
    expect(BEGIN).toBeLessThan(COMMIT);
    expect(sql).not.toMatch(/^rollback;$/m);
  });

  it("documents the backup, the dry run and the apply", () => {
    expect(sql).toMatch(/pg_dump/);
    expect(sql).toMatch(/DRY RUN/);
    expect(sql).toMatch(/rollback/i);
  });

  it("serializes against the account-lifecycle lock the release's own functions take", () => {
    expect(sql).toContain("pg_advisory_xact_lock(723081447301::bigint)");
  });
});

describe("a subject is only ever taken from proof, never from an address alone", () => {
  it("requires exactly one CONFIRMED auth user holding the resident role", () => {
    const definition = sql.slice(sql.indexOf("_unique_resident_subject on commit drop"), sql.indexOf("create unique index"));
    expect(definition).toContain("u.email_confirmed_at is not null");
    expect(definition).toContain("u.deleted_at is null");
    expect(definition).toContain("public.profile_roles r on r.user_id = u.id and r.role = 'resident'");
    expect(definition).toContain("having count(distinct u.id) = 1");
    expect(definition).toContain("lower(btrim(u.email))");
  });

  it("binds a service row only to a residency under the SAME manager and house", () => {
    for (const table of ["portal_work_order_records", "portal_service_request_records"]) {
      const update = sql.slice(sql.indexOf(`update public.${table} `));
      const body = update.slice(0, update.indexOf(";"));
      expect(body, table).toContain("rr.resident_user_id = s.resident_user_id");
      expect(body, table).toMatch(/rr\.manager_user_id = [wq]\.manager_user_id/);
      expect(body, table).toContain("rr.property_id =");
    }
  });

  it("draws those residencies from a bound application or a lease, and skips a dead application", () => {
    const residency = sql.slice(sql.indexOf("_resident_residency on commit drop"), sql.indexOf("create index on _resident_residency"));
    expect(residency).toContain("a.row_data->>'residentUserId'");
    expect(residency).toContain("public.portal_lease_pipeline_records l");
    expect(residency).toContain("'withdrawnAt'");
    expect(residency).toContain("not in ('rejected', 'withdrawn')");
    // Every place an application can record its house, the same set the route-side resolver reads.
    for (const source of ["a.assigned_property_id", "a.property_id", "'assignedPropertyId'", "'propertyId'", "'{application,propertyId}'"]) {
      expect(residency, source).toContain(source);
    }
  });
});

describe("every write is guarded, so a re-run is a no-op", () => {
  it("only ever fills a subject that is still null", () => {
    const applications = sql.slice(sql.indexOf("update public.manager_application_records"));
    expect(applications.slice(0, applications.indexOf(";"))).toContain("row_data->>'residentUserId', '')), '') is null");
    for (const table of ["portal_work_order_records", "portal_service_request_records"]) {
      const update = sql.slice(sql.indexOf(`update public.${table} `));
      expect(update.slice(0, update.indexOf(";")), table).toMatch(/\.resident_user_id is null/);
    }
  });

  it("keeps the column and the payload in step, which the disabled trigger would otherwise do", () => {
    for (const table of ["portal_work_order_records", "portal_service_request_records"]) {
      const update = sql.slice(sql.indexOf(`update public.${table} `));
      const body = update.slice(0, update.indexOf(";"));
      expect(body, table).toContain("set resident_user_id = s.resident_user_id");
      expect(body, table).toContain("'{residentUserId}'");
    }
  });
});

describe("the subject-assign guard is disabled narrowly and restored", () => {
  it("touches only the two service tables, and re-enables both before commit", () => {
    const disables = sql.match(/alter table public\.(\w+) disable trigger resident_service_subject;/g) ?? [];
    const enables = sql.match(/alter table public\.(\w+) enable trigger resident_service_subject;/g) ?? [];
    expect(disables).toHaveLength(2);
    expect(enables).toHaveLength(2);
    expect(disables.join("\n")).toContain("portal_work_order_records");
    expect(disables.join("\n")).toContain("portal_service_request_records");
    expect(sql.lastIndexOf("enable trigger resident_service_subject")).toBeLessThan(COMMIT);
    expect(sql.lastIndexOf("disable trigger resident_service_subject")).toBeLessThan(sql.indexOf("enable trigger resident_service_subject"));
  });

  it("disables nothing on manager_application_records, which has no such trigger", () => {
    expect(sql).not.toMatch(/alter table public\.manager_application_records disable trigger/);
  });

  it("verifies both triggers are back on before it commits", () => {
    expect(sql).toContain("pg_catalog.pg_trigger");
    expect(sql).toContain("t.tgname = 'resident_service_subject'");
  });
});

describe("a dry run is readable", () => {
  it("previews before it writes and verifies after", () => {
    const firstPreview = sql.indexOf("as preview");
    const firstUpdate = sql.indexOf("update public.");
    const firstVerify = sql.indexOf("as verify");
    expect(firstPreview).toBeGreaterThan(-1);
    expect(firstPreview).toBeLessThan(firstUpdate);
    expect(firstVerify).toBeGreaterThan(sql.lastIndexOf("update public."));
  });

  it("checks the column and the payload cannot disagree", () => {
    expect(sql).toContain("subject/payload disagreement");
  });
});

describe("the release doc records it as a mandatory step", () => {
  it("names the script, its position in the ladder, and both environments", () => {
    const doc = readFileSync("docs/security/2026-10-30-auth-onboarding-independent-review.md", "utf8");
    expect(doc).toContain("bind-existing-resident-subjects-20261030.sql");
    expect(doc).toMatch(/after the migrations/i);
    expect(doc).toMatch(/before the code deploy/i);
    expect(doc).toMatch(/staging/i);
  });
});
