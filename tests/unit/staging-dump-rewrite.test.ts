import { describe, expect, it } from "vitest";
import { IMPORT_SCHEMAS, rewriteDumpSchema } from "../../scripts/lib/prod-staging-merge.mjs";

/**
 * The incremental refresh restores production's dump into throwaway import
 * schemas so a bad dump can never empty staging. Retargeting that dump is a
 * text rewrite over a file whose COPY blocks are opaque user data — tenant
 * rows, JSONB blobs, message bodies — so the rewrite has exactly one job it
 * must not get wrong: touch the structural lines and nothing else.
 *
 * A global search-and-replace passes a smoke test and silently corrupts any row
 * whose data happens to contain the qualifier text, which is entirely possible
 * in a JSONB column. These cases pin the boundary.
 */
const COPY_HEADER = 'COPY "public"."profiles" ("id", "row_data") FROM stdin;';

describe("rewriteDumpSchema", () => {
  it("retargets COPY headers at the import schema", () => {
    const out = rewriteDumpSchema(`${COPY_HEADER}\n\\.\n`, IMPORT_SCHEMAS);
    expect(out).toContain('COPY "prod_import"."profiles" ("id", "row_data") FROM stdin;');
  });

  it("maps auth to its own import schema", () => {
    const out = rewriteDumpSchema('COPY "auth"."users" ("id") FROM stdin;\n\\.\n', IMPORT_SCHEMAS);
    expect(out).toContain('COPY "prod_import_auth"."users" ("id") FROM stdin;');
  });

  it("never rewrites inside a COPY payload", () => {
    const payload = 'row-1\t{"note": "\\"public\\".\\"profiles\\""}';
    const out = rewriteDumpSchema(`${COPY_HEADER}\n${payload}\n\\.\n`, IMPORT_SCHEMAS);
    expect(out.split("\n")[1]).toBe(payload);
    expect(out).not.toContain('{"note": "\\"prod_import\\"');
  });

  it("resumes rewriting after a COPY block terminates", () => {
    const sql = [
      COPY_HEADER,
      'data\t"public"."decoy"',
      "\\.",
      'COPY "public"."leases" ("id") FROM stdin;',
      "\\.",
    ].join("\n");
    const lines = rewriteDumpSchema(sql, IMPORT_SCHEMAS).split("\n");
    expect(lines[1]).toBe('data\t"public"."decoy"');
    expect(lines[3]).toBe('COPY "prod_import"."leases" ("id") FROM stdin;');
  });

  it("drops setval lines, which would fail against sequence-less import schemas", () => {
    const sql = `SELECT pg_catalog.setval('"auth"."refresh_tokens_id_seq"', 42, true);\n${COPY_HEADER}\n\\.\n`;
    const out = rewriteDumpSchema(sql, IMPORT_SCHEMAS);
    expect(out).not.toContain("setval");
    expect(out).toContain('COPY "prod_import"."profiles"');
  });

  it("leaves schemas it was not given a mapping for alone", () => {
    const out = rewriteDumpSchema('COPY "storage"."objects" ("id") FROM stdin;\n\\.\n', IMPORT_SCHEMAS);
    expect(out).toContain('COPY "storage"."objects"');
  });

  it("leaves the dump's leading SET preamble untouched", () => {
    const preamble = "SET statement_timeout = 0;\nSELECT pg_catalog.set_config('search_path', '', false);";
    expect(rewriteDumpSchema(`${preamble}\n`, IMPORT_SCHEMAS)).toBe(`${preamble}\n`);
  });
});
