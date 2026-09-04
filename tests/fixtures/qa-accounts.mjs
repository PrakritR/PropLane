/**
 * THE canonical QA account list. Every doc, e2e spec, seed script and QA audit
 * reads it from here.
 *
 * It used to live in a doc as prose, restated in `tests/fixtures/index.ts`, and
 * hardcoded again in a dozen `scripts/qa-*.mjs` files. Nothing kept them in
 * agreement, so a `.env.test` that disagreed with the doc made the doc silently
 * wrong — and "Invalid login credentials" (the account had been removed by a dev
 * reset) was indistinguishable from a wrong password. `npm run test:accounts:check`
 * answers that question in one command.
 *
 * Plain `.mjs` on purpose: the QA scripts are ESM node scripts with no TS
 * loader, so a `.ts` source could not be the single source they all share.
 *
 * `?.trim() ||` (never `??`): GitHub Actions injects a MISSING secret as an
 * empty string, which must fall back to the seeded default just like an unset
 * var. tests/global-setup.ts and tests/helpers/seed-test-db.mjs resolve
 * identically.
 */

/** @typedef {{ key: string, label: string, email: string, password: string, role: string, home: string }} QaAccount */

/** @type {Record<string, QaAccount>} */
export const QA_ACCOUNTS = {
  manager: {
    key: "manager",
    label: "Manager (demo portfolio, Business, 20 listings)",
    email: process.env.E2E_MANAGER_EMAIL?.trim() || "manager@test.proplane.local",
    password: process.env.E2E_MANAGER_PASSWORD?.trim() || "TestManager123!",
    role: "manager",
    home: "/portal/dashboard",
  },
  manager2: {
    key: "manager2",
    label: "Second manager (isolated flows, browse catalog)",
    email: process.env.E2E_MANAGER2_EMAIL?.trim() || "manager2@test.proplane.local",
    password: process.env.E2E_MANAGER2_PASSWORD?.trim() || "TestManager123!",
    role: "manager",
    home: "/portal/dashboard",
  },
  resident: {
    key: "resident",
    label: "Resident",
    email: process.env.E2E_RESIDENT_EMAIL?.trim() || "resident@test.proplane.local",
    password: process.env.E2E_RESIDENT_PASSWORD?.trim() || "TestResident123!",
    role: "resident",
    home: "/resident/dashboard",
  },
  vendor: {
    key: "vendor",
    label: "Vendor",
    email: process.env.E2E_VENDOR_EMAIL?.trim() || "vendor@test.proplane.local",
    password: process.env.E2E_VENDOR_PASSWORD?.trim() || "TestVendor123!",
    role: "vendor",
    home: "/vendor/dashboard",
  },
  admin: {
    key: "admin",
    label: "Admin",
    email: process.env.E2E_ADMIN_EMAIL?.trim() || "admin@test.proplane.local",
    password: process.env.E2E_ADMIN_PASSWORD?.trim() || "TestAdmin123!",
    role: "admin",
    home: "/admin/dashboard",
  },
};

/** The four portals an exhaustive audit walks, in the order it walks them. */
export const QA_PORTAL_ACCOUNT_KEYS = ["manager", "resident", "vendor", "admin"];

/** Shape the QA audit scripts consume: keyed by portal, `{ email, password, role, home }`. */
export function qaPortalAccounts() {
  return Object.fromEntries(
    QA_PORTAL_ACCOUNT_KEYS.map((key) => {
      const { email, password, role, home } = QA_ACCOUNTS[key];
      return [key, { email, password, role, home }];
    }),
  );
}

/** Must match the axis id seeded by tests/helpers/seed-test-db.mjs. */
export const QA_RESIDENT_AXIS_ID = process.env.E2E_RESIDENT_AXIS_ID?.trim() || "AXIS-TESTRSID";
