import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

export const SMS_RELEASE_TARGETS = Object.freeze({
  staging: "xwszcafaontidfgznlxd",
  production: "qahnczmilgptcedaqype",
});

const ENTRIES = [
  ["20260925130000", "sms_projection", "3a00309026a6e0a32145c85c216b87c150dca13844d5e7d14f47ac09553a4114"],
  ["20260925140000", "sms_projection_workspace_line", "3290c2fe02fcc924497b12542f6cd16309dbf9e0a9327eaffd58d46e1e7cc5c7"],
  ["20260925150000", "sms_projection_historical_import", "51d73f468725681ca7478341021776477c8bf3ac57b14db260dc54c26f3a4b89"],
  ["20260925160000", "sms_projection_corrections", "e300a47f2c32f7950ca542be099d7f0a6036dcc43bfe16f1fe618bafde853d86"],
  ["20260925170000", "sms_projection_historical_identity", "1ecf19e955afb712215052a59fa92e98f2d4554d0be9c249172c0516049ecce8"],
  ["20260925180000", "sms_projection_durability_correction2", "cb5d8878b92132481ce30804c9ef58be9264bfb6e09c9a21d428de22072605f7"],
];

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function reviewedSmsMigrations() {
  const directory = new URL("../supabase/migrations/", import.meta.url);
  const candidates = readdirSync(directory).filter((file) => /^202609251[3-8]0000_.*\.sql$/.test(file)).sort();
  const expected = ENTRIES.map(([version, name]) => `${version}_${name}.sql`);
  if (candidates.join("\0") !== expected.join("\0")) throw new Error("SMS release migration set changed");
  return ENTRIES.map(([version, name, hash]) => {
    const sql = readFileSync(new URL(`../supabase/migrations/${version}_${name}.sql`, import.meta.url), "utf8");
    if (sha256(sql) !== hash) throw new Error(`SMS release migration hash changed: ${version}`);
    return { version, name, hash, sql };
  });
}

export function assertSmsLedger(rows, migrations, { expectApplied }) {
  const byVersion = new Map();
  for (const row of rows) {
    if (byVersion.has(row.version)) throw new Error("Duplicate SMS migration ledger version");
    byVersion.set(row.version, row);
  }
  for (const migration of migrations) {
    const row = byVersion.get(migration.version);
    if (expectApplied && (!row || row.name !== migration.name ||
      !Array.isArray(row.statements) || sha256(row.statements.join("\n")) !== migration.hash)) {
      throw new Error(`SMS migration ledger differs: ${migration.version}`);
    }
    if (!expectApplied && row) throw new Error(`SMS migration already recorded: ${migration.version}`);
  }
}
