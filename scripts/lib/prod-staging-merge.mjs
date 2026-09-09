/**
 * Three-way merge planner for a production → staging refresh.
 *
 * Inputs are per primary key: whether the row exists in current prod, current
 * staging, and the last applied prod snapshot, plus equality to that snapshot.
 *
 * Conflict rule (captain): when both sides changed the same row, production wins.
 * Staging-only rows (never in a snapshot) are kept.
 */

export const PROD_REF = "qahnczmilgptcedaqype";
export const STAGING_REF = "xwszcafaontidfgznlxd";

/** Live schema → the throwaway schema its production dump is restored into. */
export const IMPORT_SCHEMAS = { public: "prod_import", auth: "prod_import_auth" };

function replaceQualifier(line, mapping) {
  return line.replace(/"([A-Za-z_][A-Za-z0-9_]*)"\./g, (match, schema) =>
    mapping[schema] ? `"${mapping[schema]}".` : match,
  );
}

/**
 * Point a `pg_dump --data-only` file at the import schemas instead of the live ones.
 *
 * Only structural lines are rewritten. A COPY payload is opaque tab-delimited
 * data that can contain anything a user typed — a JSONB column holding the text
 * `"public"."profiles"` is entirely possible — so a blind global replace would
 * silently corrupt rows. Tracking the COPY block boundaries (`FROM stdin;` to a
 * line that is exactly `\.`) keeps the rewrite off the data.
 *
 * `setval` lines are dropped rather than retargeted: the import schemas are
 * built with a plain LIKE and own no sequences, so a rewritten setval would
 * fail on a missing relation. Sequence state is staging's, and the apply step
 * re-derives it from the merged rows.
 */
export function rewriteDumpSchema(sql, mapping = IMPORT_SCHEMAS) {
  const out = [];
  let inCopy = false;
  for (const line of sql.split("\n")) {
    if (inCopy) {
      if (line === "\\.") inCopy = false;
      out.push(line);
      continue;
    }
    if (line.startsWith("COPY ")) {
      inCopy = true;
      out.push(replaceQualifier(line, mapping));
      continue;
    }
    if (line.includes("setval(")) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** Columns actually emitted by pg_dump, grouped by source table. */
export function extractDumpCopyColumns(sql) {
  const tables = [];
  let inCopy = false;
  for (const line of sql.split("\n")) {
    if (inCopy) {
      if (line === "\\.") inCopy = false;
      continue;
    }
    const match = line.match(/^COPY "([^"]+)"\."([^"]+)" \((.+)\) FROM stdin;$/);
    if (!match) continue;
    const columns = [...match[3].matchAll(/"((?:[^"]|"")+)"(?:, |$)/g)].map((entry) =>
      entry[1].replaceAll('""', '"'),
    );
    if (columns.length === 0) throw new Error(`COPY column list could not be parsed for ${match[1]}.${match[2]}`);
    tables.push({ schema: match[1], table: match[2], columns });
    inCopy = true;
  }
  return tables;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildImportColumnManifestSql(dumps) {
  const rows = dumps.flatMap(({ sql }) =>
    extractDumpCopyColumns(sql).flatMap(({ schema, table, columns }) => {
      const importSchema = IMPORT_SCHEMAS[schema];
      if (!importSchema) return [];
      return columns.map((column) => `(${sqlLiteral(importSchema)}, ${sqlLiteral(table)}, ${sqlLiteral(column)})`);
    }),
  );
  if (rows.length === 0) throw new Error("production dumps contained no COPY column metadata");
  return `
set role postgres;
do $$
begin
  if to_regclass('prod_import._axis_import_columns') is not null then
    raise exception 'reserved import metadata table already exists';
  end if;
end $$;
create table prod_import._axis_import_columns (
  import_schema text not null,
  table_name text not null,
  column_name text not null,
  primary key (import_schema, table_name, column_name)
);
insert into prod_import._axis_import_columns (import_schema, table_name, column_name)
values
${rows.join(",\n")};
`;
}

/**
 * @param {{
 *   inProd: boolean,
 *   inStaging: boolean,
 *   inSnapshot: boolean,
 *   prodEqualsSnapshot?: boolean,
 *   stagingEqualsSnapshot?: boolean,
 * }} row
 * @returns {"noop" | "insert-prod" | "update-prod" | "keep-staging" | "delete-staging"}
 */
export function decideRowFate(row) {
  const inProd = Boolean(row.inProd);
  const inStaging = Boolean(row.inStaging);
  const inSnapshot = Boolean(row.inSnapshot);
  const prodEqualsSnapshot = row.prodEqualsSnapshot !== false;
  const stagingEqualsSnapshot = row.stagingEqualsSnapshot !== false;

  if (!inProd && !inStaging) return "noop";

  if (!inProd) {
    return inSnapshot ? "delete-staging" : "keep-staging";
  }

  if (!inStaging) return "insert-prod";

  if (!inSnapshot) return "update-prod";

  if (prodEqualsSnapshot && stagingEqualsSnapshot) return "noop";
  if (prodEqualsSnapshot && !stagingEqualsSnapshot) return "keep-staging";
  return "update-prod";
}

export function assertCloneEndpoint({ kind, url }) {
  const value = String(url || "");
  if (kind === "prod") {
    if (!value.includes(`${PROD_REF}.supabase.co`) && !value.includes(PROD_REF)) {
      throw new Error(`prod endpoint must name ${PROD_REF}`);
    }
    if (value.includes(STAGING_REF)) {
      throw new Error("prod endpoint must not name the staging project");
    }
    return;
  }
  if (kind === "staging") {
    if (!value.includes(`${STAGING_REF}.supabase.co`) && !value.includes(STAGING_REF)) {
      throw new Error(`staging endpoint must name ${STAGING_REF}`);
    }
    if (value.includes(PROD_REF)) {
      throw new Error("staging endpoint must not name the live production project");
    }
    return;
  }
  throw new Error(`unknown endpoint kind: ${kind}`);
}
