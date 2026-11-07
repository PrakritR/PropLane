import { test, expect } from "@playwright/test";
import { expectOwnedWorkspaceReady, signInWritableSoftwareManager } from "../helpers/owned-manager-workspace-e2e";

/**
 * The settings rail scrolls independently of the content on the right
 * (PLAN-0916-1040). Before this change the rail was a `sticky` block capped at
 * `100dvh - 5.5rem` inside the page's shorter scroll body, so "Spreadsheets" sat
 * below the fold and its inner scroll could never reach it.
 *
 * Tagged @ladder-smoke: a fast regression that belongs in the release smoke set.
 */
test.describe("Settings rail — independent scroll", () => {
  test(
    "Integrations stays reachable at 600px and the rail scrolls independently at a short desktop height",
    { tag: "@ladder-smoke" },
    async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 600 });
      const workspace = await signInWritableSoftwareManager(page);
      await page.goto("/portal/profile?tab=workspaces", { waitUntil: "domcontentloaded" });
      await expectOwnedWorkspaceReady(page, workspace);

      const rail = page.locator('nav[aria-label="Settings sections"]');
      await expect(rail).toBeVisible();
      await expect(page.locator('[data-attr="settings-nav-spreadsheets"]')).toHaveCount(1);

      const integrations = page.locator('[data-attr="settings-nav-spreadsheets"]');
      await integrations.scrollIntoViewIfNeeded();
      await expect(integrations).toBeInViewport();
      await page.setViewportSize({ width: 1280, height: 460 });
      await rail.evaluate((nav) => { nav.scrollTop = 0; });
      // The real rail now overflows; no test-injected rows or style changes.
      const before = await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Settings sections"]') as HTMLElement;
        const svc = document.querySelector('[data-attr="settings-nav-spreadsheets"]') as HTMLElement;
        const navRect = nav.getBoundingClientRect();
        return {
          scrollable: nav.scrollHeight > nav.clientHeight + 2,
          servicesBelowFold: svc.getBoundingClientRect().bottom > navRect.bottom + 1,
        };
      });
      expect(before.scrollable).toBe(true);
      expect(before.servicesBelowFold).toBe(true);

      // Scrolling the rail's own <nav> brings Spreadsheets fully into view.
      const afterRailScroll = await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Settings sections"]') as HTMLElement;
        nav.scrollTop = nav.scrollHeight;
        const svc = document.querySelector('[data-attr="settings-nav-spreadsheets"]') as HTMLElement;
        const navRect = nav.getBoundingClientRect();
        const svcRect = svc.getBoundingClientRect();
        return { railScrollTop: nav.scrollTop, servicesVisible: svcRect.bottom <= navRect.bottom + 1 && svcRect.top >= navRect.top - 1 };
      });
      expect(afterRailScroll.railScrollTop).toBeGreaterThan(0);
      expect(afterRailScroll.servicesVisible).toBe(true);

      // Automations has enough real settings to overflow this short viewport.
      await page.locator('[data-attr="settings-nav-applicationsLeases"]').click();
      await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();

      // Scrolling the content column does not move the rail.
      const contentMoved = await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Settings sections"]') as HTMLElement;
        const content = document.querySelector('[data-attr="settings-content"]') as HTMLElement | null;
        const railBefore = nav.scrollTop;
        const contentBefore = content?.scrollTop ?? 0;
        if (content) content.scrollTop = content.scrollHeight;
        return { railBefore, railAfter: nav.scrollTop, distinct: content !== nav, scrollable: Boolean(content && content.scrollHeight > content.clientHeight + 2), contentBefore, contentAfter: content?.scrollTop ?? 0 };
      });
      expect(contentMoved.distinct).toBe(true);
      expect(contentMoved.scrollable).toBe(true);
      expect(contentMoved.contentAfter).toBeGreaterThan(contentMoved.contentBefore);
      expect(contentMoved.railAfter).toBe(contentMoved.railBefore);

      // Switching panes resets the content column to the top.
      await page.evaluate(() => {
        const content = document.querySelector('[data-attr="settings-content"]') as HTMLElement | null;
        if (content) content.scrollTop = content.scrollHeight;
      });
      await page.locator('[data-attr="settings-nav-spreadsheets"]').click();
      await expect(page.getByRole("heading", { name: "Integrations", exact: true })).toBeVisible();
      const contentTop = await page.evaluate(() => {
        const content = document.querySelector('[data-attr="settings-content"]') as HTMLElement | null;
        if (!content) throw new Error("Settings content column is missing.");
        return content.scrollTop;
      });
      expect(contentTop).toBeLessThanOrEqual(2);
    },
  );
});
