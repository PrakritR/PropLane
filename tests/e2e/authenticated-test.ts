import { test as base } from "@playwright/test";
import { signInAsAdmin, signInAsManager, signInAsResident } from "../helpers/auth";

export type E2EAuthRole = "admin" | "manager" | "resident";

type AuthenticatedFixtures = {
  /** Optional per-test role. Null keeps the browser unauthenticated. */
  authRole: E2EAuthRole | null;
};

/**
 * Every authenticated test starts with an empty context and signs in once for
 * that test. Supabase refresh tokens rotate, so a serialized role storage state
 * cannot safely be shared by independent test contexts.
 */
export const test = base.extend<AuthenticatedFixtures>({
  authRole: [null, { option: true }],
  storageState: async ({}, applyStorageState) => {
    await applyStorageState({ cookies: [], origins: [] });
  },
  page: async ({ page, authRole }, providePage) => {
    if (authRole === "admin") await signInAsAdmin(page);
    if (authRole === "manager") await signInAsManager(page);
    if (authRole === "resident") await signInAsResident(page);
    await providePage(page);
  },
});

export { expect } from "@playwright/test";
export type { Page, Locator } from "@playwright/test";
