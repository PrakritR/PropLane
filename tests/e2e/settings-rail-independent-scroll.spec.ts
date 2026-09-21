import { test, expect } from "@playwright/test";
import { signInAsManager } from "../helpers/auth";

/**
 * The settings rail scrolls independently of the content on the right
 * (PLAN-0916-1040). Before this change the rail was a `sticky` block capped at
 * `100dvh - 5.5rem` inside the page's shorter scroll body, so "Services" sat
 * below the fold and its inner scroll could never reach it.
 *
 * Tagged @ladder-smoke: a fast regression that belongs in the release smoke set.
 */
test.describe("Settings rail — independent scroll", () => {
  test(
    "at 1280x800 the rail reaches Services on its own, and content scroll leaves it put",
    { tag: "@ladder-smoke" },
    async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await signInAsManager(page);
      await page.goto("/portal/profile?tab=inspections", { waitUntil: "domcontentloaded" });

      const rail = page.locator('nav[aria-label="Settings sections"]');
      await expect(rail).toBeVisible();
      await expect(page.locator('[data-attr="settings-nav-services"]')).toHaveCount(1);

      // The rail is its own scroll container, and Services starts below its fold.
      const before = await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Settings sections"]') as HTMLElement;
        const svc = document.querySelector('[data-attr="settings-nav-services"]') as HTMLElement;
        const navRect = nav.getBoundingClientRect();
        return {
          scrollable: nav.scrollHeight > nav.clientHeight + 2,
          servicesBelowFold: svc.getBoundingClientRect().bottom > navRect.bottom + 1,
        };
      });
      expect(before.scrollable).toBe(true);
      expect(before.servicesBelowFold).toBe(true);

      // Scrolling the rail's own <nav> brings Services fully into view.
      const afterRailScroll = await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Settings sections"]') as HTMLElement;
        nav.scrollTop = nav.scrollHeight;
        const svc = document.querySelector('[data-attr="settings-nav-services"]') as HTMLElement;
        const navRect = nav.getBoundingClientRect();
        const svcRect = svc.getBoundingClientRect();
        return { railScrollTop: nav.scrollTop, servicesVisible: svcRect.bottom <= navRect.bottom + 1 && svcRect.top >= navRect.top - 1 };
      });
      expect(afterRailScroll.railScrollTop).toBeGreaterThan(0);
      expect(afterRailScroll.servicesVisible).toBe(true);

      // Scrolling the content column does not move the rail.
      const contentMoved = await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Settings sections"]') as HTMLElement;
        const content = document.querySelector('[class*="lg:overflow-y-auto"]') as HTMLElement | null;
        const railBefore = nav.scrollTop;
        if (content) content.scrollTop = content.scrollHeight;
        return { railBefore, railAfter: nav.scrollTop, hadContent: Boolean(content) };
      });
      expect(contentMoved.railAfter).toBe(contentMoved.railBefore);

      // Switching panes resets the content column to the top.
      await page.evaluate(() => {
        const content = document.querySelector('[class*="lg:overflow-y-auto"]') as HTMLElement | null;
        if (content) content.scrollTop = content.scrollHeight;
      });
      await page.locator('[data-attr="settings-nav-bookings"]').click();
      await page.waitForTimeout(400);
      const contentTop = await page.evaluate(() => {
        const content = document.querySelector('[class*="lg:overflow-y-auto"]') as HTMLElement | null;
        return content ? content.scrollTop : 0;
      });
      expect(contentTop).toBeLessThanOrEqual(2);
    },
  );
});
