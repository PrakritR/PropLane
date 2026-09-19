import { test as setup } from "@playwright/test";
import { signInAsAdmin, signInAsManager, signInAsResident } from "../helpers/auth";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

setup("authenticate manager", async ({ page }) => {
  setup.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");
  await signInAsManager(page);
});

setup("authenticate resident", async ({ page }) => {
  setup.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");
  await signInAsResident(page);
});

setup("authenticate admin", async ({ page }) => {
  setup.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");
  await signInAsAdmin(page);
});
