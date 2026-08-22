import { test as setup } from "@playwright/test";
import path from "node:path";
import { signInAsAdmin, signInAsManager, signInAsResident } from "../helpers/auth";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";
const authDir = path.join(__dirname, "../.auth");

setup("authenticate manager", async ({ page }) => {
  setup.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");
  await signInAsManager(page);
  await page.context().storageState({ path: path.join(authDir, "manager.json") });
});

setup("authenticate resident", async ({ page }) => {
  setup.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");
  await signInAsResident(page);
  await page.context().storageState({ path: path.join(authDir, "resident.json") });
});

setup("authenticate admin", async ({ page }) => {
  setup.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");
  await signInAsAdmin(page);
  await page.context().storageState({ path: path.join(authDir, "admin.json") });
});
