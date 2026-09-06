import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_PURGE_RETAINED,
  ACCOUNT_PURGE_TABLES,
  NON_OWNERSHIP_COLUMNS,
  type PurgeScope,
} from "@/lib/auth/account-purge-manifest";

/**
 * The purge gap this guards was invisible: the schema grew to 100+ tables while the delete
 * path named ~30 inline, so a "permanently deleted" account left bank accounts, budgets,
 * expenses, API keys, SMS logs, calendar links, invite links, tour links and agent history
 * behind — and re-registering the same email landed on an account that remembered the last
 * one. This reads the migrations rather than a copied list, so a NEW table is a failure here
 * before it is a leak in production. Classify it in the manifest (which columns own a row
 * for which account) or in ACCOUNT_PURGE_RETAINED (why nothing owns it).
 */

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

/** `resident_email`, `manager_user_id`, `landlord_id`, `email`, `user_id`, … */
const OWNERSHIP_COLUMN_RE = /(^|_)(user_id|email)$|^landlord_id$/;

type Schema = { tables: Map<string, Set<string>> };

function readSchema(): Schema {
  const tables = new Map<string, Set<string>>();
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");

    for (const match of sql.matchAll(
      /create table\s+(?:if not exists\s+)?(?:public\.)?([a-z_]+)\s*\(([\s\S]*?)\n\);/gi,
    )) {
      const table = match[1].toLowerCase();
      if (table === "if") continue;
      const columns = tables.get(table) ?? new Set<string>();
      for (const line of match[2].split("\n")) {
        const col = /^\s*([a-z_]+)\s+(uuid|text|citext|varchar)\b/i.exec(line);
        if (col) columns.add(col[1].toLowerCase());
      }
      tables.set(table, columns);
    }

    // `work_order_events` → `action_events`: the live table is the renamed one.
    for (const match of sql.matchAll(
      /alter table\s+(?:if exists\s+)?(?:public\.)?([a-z_]+)\s+rename to\s+(?:public\.)?([a-z_]+)/gi,
    )) {
      const [from, to] = [match[1].toLowerCase(), match[2].toLowerCase()];
      const columns = tables.get(from);
      if (columns) {
        tables.set(to, new Set([...columns, ...(tables.get(to) ?? [])]));
        tables.delete(from);
      }
    }

    for (const match of sql.matchAll(
      /alter table\s+(?:if exists\s+)?(?:public\.)?([a-z_]+)([\s\S]*?);/gi,
    )) {
      const table = match[1].toLowerCase();
      const columns = tables.get(table);
      if (!columns) continue;
      for (const col of match[2].matchAll(/add column\s+(?:if not exists\s+)?([a-z_]+)\s+(uuid|text|citext)\b/gi)) {
        columns.add(col[1].toLowerCase());
      }
      for (const col of match[2].matchAll(/rename column\s+([a-z_]+)\s+to\s+([a-z_]+)/gi)) {
        if (columns.delete(col[1].toLowerCase())) columns.add(col[2].toLowerCase());
      }
      for (const col of match[2].matchAll(/drop column\s+(?:if exists\s+)?([a-z_]+)/gi)) {
        columns.delete(col[1].toLowerCase());
      }
    }
  }

  return { tables };
}

const SCOPES: PurgeScope[] = ["manager", "resident", "vendor"];

function manifestColumnsFor(table: string): Set<string> {
  const rule = ACCOUNT_PURGE_TABLES.find((entry) => entry.table === table);
  const columns = new Set<string>();
  if (!rule) return columns;
  for (const scope of SCOPES) {
    const scopeRule = rule[scope];
    if (!scopeRule) continue;
    for (const key of ["ids", "emails", "detachIds", "detachEmails"] as const) {
      for (const column of scopeRule[key] ?? []) columns.add(column);
    }
  }
  return columns;
}

describe("account purge coverage", () => {
  const schema = readSchema();

  it("reads the real migration schema", () => {
    expect(schema.tables.size).toBeGreaterThan(90);
    // Sanity: a table the purge definitely has to know about, with its owner column.
    expect([...(schema.tables.get("manager_property_records") ?? [])]).toContain("manager_user_id");
  });

  it("classifies every table as purged or explicitly retained", () => {
    const listed = new Set(ACCOUNT_PURGE_TABLES.map((rule) => rule.table));
    const unclassified = [...schema.tables.keys()].filter(
      (table) => !listed.has(table) && !(table in ACCOUNT_PURGE_RETAINED),
    );
    expect(unclassified, "add these to ACCOUNT_PURGE_TABLES or ACCOUNT_PURGE_RETAINED").toEqual([]);
  });

  it("classifies every ownership column on a purged table", () => {
    const unclassified: string[] = [];
    for (const [table, columns] of schema.tables) {
      if (table in ACCOUNT_PURGE_RETAINED) continue;
      const known = manifestColumnsFor(table);
      for (const column of columns) {
        if (!OWNERSHIP_COLUMN_RE.test(column)) continue;
        if (known.has(column)) continue;
        if (`${table}.${column}` in NON_OWNERSHIP_COLUMNS) continue;
        unclassified.push(`${table}.${column}`);
      }
    }
    expect(
      unclassified.sort(),
      "name the column in ACCOUNT_PURGE_TABLES, or record why it is not an account key in NON_OWNERSHIP_COLUMNS",
    ).toEqual([]);
  });

  it("does not name a table or column the schema no longer has", () => {
    const stale: string[] = [];
    for (const rule of ACCOUNT_PURGE_TABLES) {
      const columns = schema.tables.get(rule.table);
      if (!columns) {
        stale.push(rule.table);
        continue;
      }
      for (const column of manifestColumnsFor(rule.table)) {
        if (!columns.has(column)) stale.push(`${rule.table}.${column}`);
      }
    }
    for (const table of Object.keys(ACCOUNT_PURGE_RETAINED)) {
      if (!schema.tables.has(table)) stale.push(table);
    }
    expect(stale.sort()).toEqual([]);
  });

  it("gives every retained table a reason", () => {
    for (const [table, reason] of Object.entries(ACCOUNT_PURGE_RETAINED)) {
      expect(reason.length, `${table} needs a reason`).toBeGreaterThan(10);
    }
  });
});
