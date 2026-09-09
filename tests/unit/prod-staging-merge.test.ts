import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  assertCloneEndpoint,
  buildImportColumnManifestSql,
  decideRowFate,
  extractDumpCopyColumns,
  PROD_REF,
  STAGING_REF,
} from "../../scripts/lib/prod-staging-merge.mjs";

describe("production dump column manifest", () => {
  const dump = `COPY "public"."sms_outbox" ("id", "status", "body") FROM stdin;
row-1\tpending\thello
\\.
`;

  it("records only columns explicitly carried by the production dump", () => {
    expect(extractDumpCopyColumns(dump)).toEqual([
      { schema: "public", table: "sms_outbox", columns: ["id", "status", "body"] },
    ]);
    const sql = buildImportColumnManifestSql([{ sql: dump }]);
    expect(sql).toContain("('prod_import', 'sms_outbox', 'body')");
    expect(sql).not.toContain("conversation_log_status");
  });

  it("does not interpret COPY-shaped customer data as dump structure", () => {
    const shapedPayload = `COPY "public"."notes" ("body") FROM stdin;
COPY "public"."sms_outbox" ("id", "conversation_log_status") FROM stdin;
\\.
`;
    expect(extractDumpCopyColumns(shapedPayload)).toEqual([
      { schema: "public", table: "notes", columns: ["body"] },
    ]);
  });

  it("fails closed when no table column metadata can be recovered", () => {
    expect(() => buildImportColumnManifestSql([{ sql: "-- empty dump" }])).toThrow(
      /no COPY column metadata/,
    );
  });

  it("limits merge writes and comparisons to production-carried columns", () => {
    const applySql = readFileSync("scripts/lib/staging-merge-apply.sql", "utf8");
    expect(applySql).toContain("join prod_import._axis_import_columns");
    expect(applySql).toContain("a.attgenerated = ''");
    expect(applySql).toContain("to_jsonb(p)");
    expect(applySql).not.toContain("to_jsonb(p.*)");
  });
});

describe("decideRowFate", () => {
  it("keeps a staging-only row that was never in a snapshot", () => {
    expect(
      decideRowFate({ inProd: false, inStaging: true, inSnapshot: false }),
    ).toBe("keep-staging");
  });

  it("deletes a row prod removed", () => {
    expect(
      decideRowFate({ inProd: false, inStaging: true, inSnapshot: true }),
    ).toBe("delete-staging");
  });

  it("inserts a row that is new on prod", () => {
    expect(
      decideRowFate({ inProd: true, inStaging: false, inSnapshot: false }),
    ).toBe("insert-prod");
  });

  it("restores a row staging deleted when prod still has it", () => {
    expect(
      decideRowFate({ inProd: true, inStaging: false, inSnapshot: true }),
    ).toBe("insert-prod");
  });

  it("keeps a staging edit when prod did not change", () => {
    expect(
      decideRowFate({
        inProd: true,
        inStaging: true,
        inSnapshot: true,
        prodEqualsSnapshot: true,
        stagingEqualsSnapshot: false,
      }),
    ).toBe("keep-staging");
  });

  it("takes prod when only prod changed", () => {
    expect(
      decideRowFate({
        inProd: true,
        inStaging: true,
        inSnapshot: true,
        prodEqualsSnapshot: false,
        stagingEqualsSnapshot: true,
      }),
    ).toBe("update-prod");
  });

  it("takes prod when both sides changed", () => {
    expect(
      decideRowFate({
        inProd: true,
        inStaging: true,
        inSnapshot: true,
        prodEqualsSnapshot: false,
        stagingEqualsSnapshot: false,
      }),
    ).toBe("update-prod");
  });

  it("no-ops when nothing changed", () => {
    expect(
      decideRowFate({
        inProd: true,
        inStaging: true,
        inSnapshot: true,
        prodEqualsSnapshot: true,
        stagingEqualsSnapshot: true,
      }),
    ).toBe("noop");
  });
});

describe("assertCloneEndpoint", () => {
  it("accepts the staging project and refuses prod as the write target", () => {
    expect(() =>
      assertCloneEndpoint({
        kind: "staging",
        url: `https://${STAGING_REF}.supabase.co`,
      }),
    ).not.toThrow();
    expect(() =>
      assertCloneEndpoint({
        kind: "staging",
        url: `https://${PROD_REF}.supabase.co`,
      }),
      // Pin the REFUSAL, not the sentence: the guard rejects any endpoint that
      // is not the staging project, and names the ref it requires. Asserting
      // the exact wording made a working prod-write guard look broken.
    ).toThrow(/staging endpoint must name/i);
  });

  it("accepts the production project as the read source", () => {
    expect(() =>
      assertCloneEndpoint({
        kind: "prod",
        url: `https://${PROD_REF}.supabase.co`,
      }),
    ).not.toThrow();
    expect(() =>
      assertCloneEndpoint({
        kind: "staging",
        url: "https://example.supabase.co",
      }),
    ).toThrow(/must name/);
  });
});
