import { QA_ACCOUNTS, QA_RESIDENT_AXIS_ID } from "./qa-accounts.mjs";

export { snapshotJordanLee } from "@/data/manager-application-snapshots";

function pick(key: keyof typeof QA_ACCOUNTS): { email: string; password: string } {
  const { email, password } = QA_ACCOUNTS[key];
  return { email, password };
}

export const TEST_RUN_PREFIX = "e2e-test";

export function testRunId(): string {
  return `${TEST_RUN_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Credentials come from tests/fixtures/qa-accounts.mjs — the ONE source the
// docs, the e2e specs, the seed script and every scripts/qa-*.mjs audit read.
// Restating them here is what let `.env.test` and the docs disagree silently.
// `npm run test:accounts:check` reports whether they actually work right now.
export const E2E_ACCOUNTS = {
  admin: pick("admin"),
  manager: pick("manager"),
  resident: pick("resident"),
  vendor: pick("vendor"),
  manager2: pick("manager2"),
};

// Must match the axis id seeded by tests/helpers/seed-test-db.mjs (same env var +
// default there): it is both the application record id and the resident's
// profiles.manager_id.
export const E2E_RESIDENT_AXIS_ID = QA_RESIDENT_AXIS_ID;
