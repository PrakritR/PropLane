import { test, expect } from "@playwright/test";
import { signInAsManager } from "../helpers/auth";

/**
 * The settings rail scrolls independently of the content on the right
 * (PLAN-0916-1040). Before this change the rail was a `sticky` block capped at
 * `100dvh - 5.5rem` inside the page's shorter scroll body, so "Integrations" sat
 * below the fold and its inner scroll could never reach it.
 *
 * Tagged @ladder-smoke: a fast regression that belongs in the release smoke set.
 */
test.describe("Settings rail — independent scroll", () => {
  test(
    "at 1280x600 the rail reaches Integrations on its own, and content scroll leaves it put",
    { tag: "@ladder-smoke" },
    async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 600 });
      await signInAsManager(page);
      await page.goto("/portal/profile?tab=workspaces", { waitUntil: "domcontentloaded" });

      const rail = page.locator('nav[aria-label="Settings sections"]');
      await expect(rail).toBeVisible();
      await expect(page.locator('[data-attr="settings-nav-spreadsheets"]')).toBeVisible();
      await expect(page.locator('[data-attr="settings-workspace-name"]')).toBeVisible();
      await expect(page.locator('[data-attr="settings-content"]')).toBeVisible();

      // The rail is its own scroll container, and Integrations starts below its fold.
      const before = await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Settings sections"]') as HTMLElement;
        const svc = document.querySelector('[data-attr="settings-nav-spreadsheets"]') as HTMLElement;
        const navRect = nav.getBoundingClientRect();
        return {
          scrollable: nav.scrollHeight > nav.clientHeight + 2 && getComputedStyle(nav).overflowY === "auto",
          integrationsBelowFold: svc.getBoundingClientRect().bottom > navRect.bottom + 1,
        };
      });
      expect(before.scrollable).toBe(true);
      expect(before.integrationsBelowFold).toBe(true);

      // Scrolling the rail's own <nav> brings Integrations fully into view.
      const afterRailScroll = await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Settings sections"]') as HTMLElement;
        nav.scrollTop = nav.scrollHeight;
        const svc = document.querySelector('[data-attr="settings-nav-spreadsheets"]') as HTMLElement;
        const navRect = nav.getBoundingClientRect();
        const svcRect = svc.getBoundingClientRect();
        return { railScrollTop: nav.scrollTop, integrationsVisible: svcRect.bottom <= navRect.bottom + 1 && svcRect.top >= navRect.top - 1 };
      });
      expect(afterRailScroll.railScrollTop).toBeGreaterThan(0);
      expect(afterRailScroll.integrationsVisible).toBe(true);

      // Scrolling the content column does not move the rail.
      const contentMoved = await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Settings sections"]') as HTMLElement;
        const content = document.querySelector('[data-attr="settings-content"]') as HTMLElement | null;
        const railBefore = nav.scrollTop;
        if (!content) throw new Error("Settings content scroll container missing.");
        content.scrollTop = content.scrollHeight;
        return { railBefore, railAfter: nav.scrollTop, hadContent: Boolean(content) };
      });
      expect(contentMoved.railAfter).toBe(contentMoved.railBefore);

      // Switching from a scrolled pane resets the content column.
      const content = page.locator('[data-attr="settings-content"]');
      await expect.poll(async () => content.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
      await content.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      await expect.poll(async () => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
      await page.locator('[data-attr="settings-nav-profile"]').click();
      await expect.poll(async () => content.evaluate((node) => node.scrollTop)).toBeLessThanOrEqual(2);
    },
  );
});
