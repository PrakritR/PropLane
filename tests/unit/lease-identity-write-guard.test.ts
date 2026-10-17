/**
 * Every code path that writes `portal_lease_pipeline_records.row_data` must put
 * the row through the identity strip. A lease row carries a COPY of the
 * application answers and, before this guard, a manager's decrypted view of the
 * applicant (SSN, birth date, licence) was persisted onto it in plain text.
 *
 * Source guard: a file under src that writes the lease table passes only if it
 * uses `stripIdentityFromLeaseRow` / `stripApplicantIdentityFromLeaseApplication`
 * (or builds the row with `normalizeLeasePipelineRow`, which strips).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const TABLE = /["'`]portal_lease_pipeline_records["'`]/;
/** A write to that table, or a const alias for it that is then written. */
const WRITE = /\.(insert|upsert|update)\(/;
const GUARDED = /stripIdentityFromLeaseRow|stripApplicantIdentityFromLeaseApplication|normalizeLeasePipelineRow/;

/** Files that name the table and call a write, but never write a lease `row_data`. */
const EXEMPT: Record<string, string> = {
  "src/app/api/portal/lease-library/route.ts": "writes the lease template library, not a lease row",
  "src/app/api/cron/send-lease-signing-reminders/route.ts": "writes portal_outbound_mail_records only",
  "src/lib/portal-record-share-links.server.ts": "writes share links only",
  "src/lib/claw-resident-messaging.server.ts": "writes messaging threads only",
  "src/lib/property-ownership-transfer.ts": "re-parents manager_user_id, row_data untouched",
  "src/lib/portfolio-import/create.server.ts": "writes applications and charges only",
  "src/lib/auth/clear-property-housing-access.ts": "clears access columns, row_data untouched",
  "src/lib/auth/migrate-portal-user-id.ts": "rewrites user id columns, row_data untouched",
  "src/lib/move-in-forms/server.ts": "writes move-in forms only",
  "src/lib/reminders/subjects/move-in-forms.server.ts": "writes move-in forms only",
  "src/lib/channel-calendar/stay-meta.server.ts": "writes schedule records only",
};

describe("lease row writers strip applicant identity", () => {
  const files = walk(join(ROOT, "src"))
    .map((file) => ({ file, rel: relative(ROOT, file), source: readFileSync(file, "utf8") }))
    .filter(({ source }) => TABLE.test(source) || /LEASE_TABLE\s*=\s*["']portal_lease_pipeline_records["']/.test(source));

  it("finds the writers (guard is not vacuous)", () => {
    const writers = files.filter(({ source }) => WRITE.test(source) || /\.rpc\(\s*["']persist_lease_with_action_event/.test(source));
    expect(writers.length).toBeGreaterThan(8);
  });

  it("every file that writes a lease row goes through the identity strip", () => {
    const offenders = files
      .filter(({ source }) => WRITE.test(source) || /\.rpc\(\s*["'](persist_lease_with_action_event|commit_room_lease_extension)/.test(source))
      .filter(({ rel, source }) => {
        if (EXEMPT[rel]) return false;
        return !GUARDED.test(source);
      })
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it("the explicitly strip-guarded writers import the helper", () => {
    for (const rel of [
      "src/app/api/portal-lease-pipeline/route.ts",
      "src/lib/existing-resident-onboarding.server.ts",
      "src/lib/lease-packet-edit.server.ts",
      "src/lib/lease-amendment.server.ts",
      "src/lib/short-stay-booking.server.ts",
      "src/lib/lease-uncountersigned-refund.server.ts",
      "src/lib/lease-fee-waiver.server.ts",
      "src/lib/lease-signing-fee-resident.server.ts",
      "src/lib/lease-issue-report.server.ts",
      "src/lib/tools/domains/leases.ts",
      "src/lib/demo/canonical-demo-portfolio-db.ts",
    ]) {
      const source = readFileSync(join(ROOT, rel), "utf8");
      expect(source, rel).toMatch(/stripIdentityFromLeaseRow/);
    }
  });

  it("the route strips at the write boundary and on read", () => {
    const source = readFileSync(join(ROOT, "src/app/api/portal-lease-pipeline/route.ts"), "utf8");
    expect(source).toMatch(/stripIdentityFromLeaseRow\(reconcileRowScope\(/);
    expect(source).toMatch(/return stripIdentityFromLeaseRow\(\{ \.\.\.row, generatedHtml \}\)/);
  });

  it("normalizeLeasePipelineRow strips the application it passes through", () => {
    const source = readFileSync(join(ROOT, "src/lib/lease-pipeline-storage.ts"), "utf8");
    expect(source).toMatch(/application: stripApplicantIdentityFromLeaseApplication\(r\.application\)/);
  });

  it("the existing-resident onboarding lease does not persist an SSN", () => {
    const source = readFileSync(join(ROOT, "src/lib/existing-resident-onboarding.server.ts"), "utf8");
    expect(source).toMatch(/row_data: stripIdentityFromLeaseRow\(row\)/);
  });
});
