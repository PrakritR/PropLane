import { readFileSync } from "node:fs";
import { sha256 } from "./sms-durability-release-manifest.mjs";

// Exact reviewed source bundle. A changed migration requires independent review.
export const IDENTITY_DEPOSIT_ENTRIES = Object.freeze([
  ["20261030010000", "deposit_return_reservations", "129ecc11d4d6ca73af0ddce16964d7013373d0cc6671796453b1969073925e72"],
  ["20261030020000", "settle_deposit_returns", "3af081368b19baf2dfd7e32f73b0786fae041c1c8614c68b9fd6a9ac1506d717"],
  ["20261030030000", "deposit_return_provider_status", "db74785a8bce3324510a9575fc9bbe69e122b152df381604a34a672d6e9b13af"],
  ["20261030040000", "reconcile_external_deposit_refunds", "47735f77b71ca874e95f6d9751bf75d94c0636462b495662e978bb5f9ce6271f"],
  ["20261030120000", "resident_identity_verification", "b57f0b014056a33f71044d6a6fe52c85e332df49023d6afcd34d73fb0179e1f1"],
  ["20261030121000", "resident_identity_events_rpc", "6afde71ffff91fafff5155b8e97dde5c1a5293ea8d76b14dcd53b38cc20c5b1a"],
  ["20261030122000", "resident_identity_retry", "dde862efb29dd9594f3f515e6901ad6fce872f7bacc54793f8bf47dfb2f6fe4c"],
  ["20261030123000", "resident_identity_provider_state", "a84d45b35b58dfe77f6340ce4ae61a528f77edcc73b8ed643173ffaa8581d7c3"],
  ["20261030130000", "resident_evidence_policies", "a0a031afd9d1416c7835f7d67eaf73165770212b68d74599c2f938c69cc075be"],
  ["20261106120000", "identity_deposit_recovery_guards", "1f62ec00ff11b39fa8b4affef27fddc161c3c8c31a4a9e87411d9480a983adba"],
  ["20261108130000", "resident_identity_null_provider_guard", "d855c3bed7ad146d3b99e43897b3f36bd44ed4a9de4a3a1b6f2420a3c23a1188"],
]);
export function reviewedIdentityDepositMigrations() {
  return IDENTITY_DEPOSIT_ENTRIES.map(([version, name, hash]) => {
    const sql = readFileSync(new URL(`../supabase/migrations/${version}_${name}.sql`, import.meta.url), "utf8");
    if (sha256(sql) !== hash) throw new Error(`Migration source changed: ${version}`);
    return { version, name, hash, sql };
  });
}
export function assertIdentityDepositLedger(rows, migrations, applied) {
  for (const migration of migrations) {
    const matches = rows.filter((row) => row.version === migration.version || row.name === migration.name);
    if (!applied && matches.length) throw new Error(`Unexpected migration ledger entry: ${migration.version}`);
    if (applied && (matches.length !== 1 || matches[0].version !== migration.version || matches[0].name !== migration.name ||
      !Array.isArray(matches[0].statements) || matches[0].statements.length !== 1 || sha256(matches[0].statements[0]) !== migration.hash)) {
      throw new Error(`Migration ledger differs: ${migration.version}`);
    }
  }
}
