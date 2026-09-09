import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `axis_admin_planned_events_v1` is a single row holding the planned-events
 * array for every manager. Under the plain conflict rule - production wins any
 * row it changed - one production edit erased every tour QA had planned on
 * staging, twice a day, which is why staging tours could not be trusted.
 *
 * The apply step is dynamic SQL built at run time, so these cases pin the
 * generated statements rather than the outcome: the guard has to reach the
 * overwrite and the delete, and it must not reach the insert, or a staging
 * database that has never seen the record would never receive it.
 */
const sql = readFileSync(join(process.cwd(), "scripts/lib/staging-merge-apply.sql"), "utf8");

const statement = (keyword: string) => {
  const start = sql.indexOf(`'${keyword}`);
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf(");", start));
};

describe("staging merge staging-owned rows", () => {
  it("claims the planned-events singleton for staging", () => {
    expect(sql).toContain(
      `('public', 'portal_schedule_records', 's."id" = ''axis_admin_planned_events_v1''')`,
    );
  });

  it("defaults to no exception, so every other table keeps production-wins", () => {
    expect(sql).toContain(
      "select coalesce(string_agg(format('not (%s)', r.pk_predicate), ' and '), 'true')",
    );
  });

  it("guards the production overwrite", () => {
    expect(statement("update %I.%I s set")).toContain("owned_guard");
  });

  it("guards the delete", () => {
    expect(statement("delete from %I.%I s")).toContain("owned_guard");
  });

  it("still inserts the row into a staging database that lacks it", () => {
    expect(statement("insert into %I.%I")).not.toContain("owned_guard");
  });
});
