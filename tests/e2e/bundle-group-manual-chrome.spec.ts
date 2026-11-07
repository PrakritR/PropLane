import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import type { DemoApplicantRow } from "../../src/data/demo-portal";
import { isDraftShapedApplicationRow } from "../../src/lib/rental-application/draft-shape";
import { E2E_ACCOUNTS } from "../fixtures";
import { establishActivePortal, signIn } from "../helpers/auth";
import { selectOwnedManagerWorkspace } from "../helpers/owned-manager-workspace-e2e";
import { ownedPublicProperty } from "../helpers/owned-public-property-e2e";

/** Read-only account-entry, existing group-detail and lease-surface walkthrough.
 * The dedicated public fixture has no bundles; this does not claim bundle wizard or joint-lease coverage.
 * PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3011 \
 *   npx playwright test tests/e2e/bundle-group-manual-chrome.spec.ts --headed --workers=1
 */
const GROUP_ID = "PROPLANE-DEMOGRP1";
const MEMBER_IDS = ["AXIS-DEMOGRPIN1", "AXIS-DEMOGRPIN2"] as const;
const EVIDENCE_DIR = path.join(process.cwd(), "test-evidence", "bundle-group-manual");
const MANAGER = E2E_ACCOUNTS.manager;

function shot(page: Page, name: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  return page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
}

async function signInPrimaryManager(page: Page) {
  expect(MANAGER.email, "Group fixtures require the exact canonical primary manager").toBe("manager@test.proplane.local");
  await signIn(page, MANAGER.email, MANAGER.password, "/portal/applications/incomplete");
  await establishActivePortal(page, "manager", "/portal/applications/incomplete");
  // This is intentionally a read-only managed-owner case. Do not require or grant write access.
  return selectOwnedManagerWorkspace(page);
}

function assertApplyContext(url: URL, propertyId: string) {
  const next = new URL(url.searchParams.get("next") ?? "", url.origin);
  expect(next.pathname).toBe("/resident/applications/apply");
  expect(next.searchParams.get("propertyId")).toBe(propertyId);
  expect(next.searchParams.has("bundle")).toBe(false);
}

function detailPath(row: DemoApplicantRow) {
  const tab = isDraftShapedApplicationRow(row) ? "incomplete" : row.bucket;
  return `/portal/applications/${tab}/${encodeURIComponent(row.id)}`;
}

async function expectGroupDetail(page: Page, current: DemoApplicantRow, members: DemoApplicantRow[]) {
  await expect(page).toHaveURL((url) => url.pathname === detailPath(current));
  await expect(page.getByText(GROUP_ID, { exact: true }).filter({ visible: true })).toBeVisible();
  for (const member of members) {
    const memberRow = page.locator("li").filter({ hasText: member.name }).filter({ visible: true });
    await expect(memberRow).toHaveCount(1);
    await expect(memberRow).toContainText(member.name);
    if (member.id === current.id) await expect(memberRow).toContainText("(this application)");
    if (member.application?.groupRole === "first") await expect(memberRow).toContainText("organizer");
  }
}

test.describe.configure({ mode: "serial", timeout: 180_000 });
test.use({ storageState: { cookies: [], origins: [] }, launchOptions: { slowMo: 400 }, viewport: { width: 1440, height: 900 } });

test.describe("Public account entry and existing group manual Chrome walkthrough", () => {
  test("anonymous listing Apply and direct account gate preserve the exact listing context", async ({ page }) => {
    const property = await ownedPublicProperty(page.request);
    expect(property.id).toBe("qa-public-tour-house");
    await page.goto(`/rent/listings/${property.id}`);
    await expect(page.getByText(property.title, { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await page.locator('[data-attr="listing-web-apply"]').filter({ visible: true }).first().click();
    await expect(page).toHaveURL((url) => url.pathname === "/auth/create-account");
    const entry = new URL(page.url());
    expect(entry.searchParams.get("role")).toBe("resident");
    expect(entry.searchParams.get("mode")).toBe("create");
    assertApplyContext(entry, property.id);
    await shot(page, "01-listing-resident-account-entry");

    await page.goto(`/rent/apply?propertyId=${property.id}`);
    const create = page.locator('[data-attr="public-apply-create-account"]');
    const signInLink = page.locator('[data-attr="public-apply-sign-in"]');
    await expect(create).toBeVisible();
    await expect(signInLink).toBeVisible();
    const createUrl = new URL((await create.getAttribute("href"))!, page.url());
    expect(createUrl.pathname).toBe("/auth/create-account");
    expect(createUrl.searchParams.get("role")).toBe("resident");
    expect(createUrl.searchParams.get("mode")).toBe("create");
    assertApplyContext(createUrl, property.id);
    const signInUrl = new URL((await signInLink.getAttribute("href"))!, page.url());
    expect(signInUrl.pathname).toBe("/auth/sign-in");
    expect(signInUrl.searchParams.get("intent")).toBe("resident");
    assertApplyContext(signInUrl, property.id);
    await expect(page.getByRole("button", { name: /Continue without an account/i })).toHaveCount(0);
    await shot(page, "02-apply-account-gate");
  });

  test("primary manager reads the exact pending group and opens its peer application", async ({ page }) => {
    const workspace = await signInPrimaryManager(page);
    const response = await page.request.get("/api/manager-applications");
    expect(response.ok(), "Authenticated application inventory must load").toBe(true);
    const { rows } = await response.json() as { rows: DemoApplicantRow[] };
    expect(Array.isArray(rows)).toBe(true);
    const members = rows.filter((row) => row.application?.groupId === GROUP_ID);
    expect(members.map((row) => row.id).sort(), "Exact audited group membership").toEqual([...MEMBER_IDS].sort());
    for (const [index, id] of MEMBER_IDS.entries()) {
      const row = members.find((member) => member.id === id)!;
      expect(row.managerUserId).toBe(workspace.ownerUserId);
      expect(row.propertyId).toBe("mgr-demo-cascade");
      expect(workspace.propertyIds).toContain(row.propertyId);
      expect(row.bucket).toBe("pending");
      expect(row.application?.groupRole).toBe(index === 0 ? "first" : "joining");
      expect(row.application?.applyingAsGroup).toBe("yes");
      expect(row.name.trim()).not.toBe("");
    }
    const organizer = members.find((row) => row.id === MEMBER_IDS[0])!;
    const peer = members.find((row) => row.id === MEMBER_IDS[1])!;
    await page.goto(detailPath(organizer));
    await expectGroupDetail(page, organizer, members);
    await shot(page, "03-organizer-group-detail");
    const peerLink = page.locator('[data-attr="application-group-member-row"]').filter({ hasText: peer.name });
    await expect(peerLink).toHaveCount(1);
    await peerLink.click();
    await expectGroupDetail(page, peer, members);
    await shot(page, "04-peer-group-detail");
  });

  test("primary manager lease surface loads", async ({ page }) => {
    await signInPrimaryManager(page);
    await page.goto("/portal/leases");
    await expect(page.getByRole("heading", { name: /leases/i }).filter({ visible: true }).first()).toBeVisible();
    await shot(page, "05-manager-lease-surface");
  });
});
