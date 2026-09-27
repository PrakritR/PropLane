import { test, expect } from "@playwright/test";
import { MANAGER_PLAN_TIERS } from "@/data/manager-plan-tiers";

test.describe("Public home", () => {
  test("loads the landing hero and both doors", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /^propLane$/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /start free/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /book a demo/i }).first()).toBeVisible();
  });

  test("header carries Pricing and Why PropLane as tabs", async ({ page }) => {
    await page.goto("/");
    const nav = page.locator("#axis-public-navbar");
    await expect(nav.getByRole("link", { name: /^pricing$/i }).first()).toHaveAttribute("href", "/pricing");
    await expect(nav.getByRole("link", { name: /^why proplane$/i }).first()).toHaveAttribute("href", "/why-proplane");
  });

  test("FAQ answers every question and closes the page", async ({ page }) => {
    await page.goto("/");

    const faq = page.getByRole("region", { name: "Questions, answered", exact: true });
    await expect(faq).toBeVisible();
    await expect(faq.getByRole("heading", { name: /questions, answered/i })).toBeVisible();

    const rows = faq.locator("details");
    await expect(rows).toHaveCount(8);
    for (const question of [
      "What is PropLane?",
      "What does the AI actually do?",
      "Is there a free plan?",
      "How much does it cost?",
      "Do I need a credit card to try it?",
      "How do my residents get in?",
      "How do we move our portfolio into PropLane?",
      "Can I use it on my phone?",
    ]) {
      await expect(faq.getByText(question, { exact: true })).toBeVisible();
    }

    // Opening a row reveals its answer.
    await faq.getByText("Is there a free plan?", { exact: true }).click();
    await expect(faq.getByText(/free is \$0 with no card/i)).toBeVisible();

    // No separate closing CTA band on home (captain 2026-09-25, src/app/(public)/page.tsx):
    // the pricing teaser and hero's own "Start free" already carry the ask, so the FAQ
    // is deliberately the last section on the page.
    await expect(page.getByRole("region", { name: "Get started", exact: true })).toHaveCount(0);
  });

  test("pricing teaser reads the three plans from the tier table", async ({ page }) => {
    await page.goto("/");
    const pricing = page.locator("#pricing");
    await pricing.scrollIntoViewIfNeeded();
    for (const tier of MANAGER_PLAN_TIERS) {
      await expect(pricing.getByText(tier.id === "free" ? "$0" : tier.monthly.headline, { exact: true })).toBeVisible();
    }
    await expect(pricing.getByRole("link", { name: /compare every feature/i })).toHaveAttribute("href", "/pricing#compare");
  });

  // Captain 2026-09-26: redesigned around static, fixture-fed real portal
  // panels (no live /demo iframe, no perspective switch — see
  // docs/agents/marketing-mocks.md). Each row's own in-panel TABS (Pending/
  // Upcoming/Past, etc.) still switch which fixture rows render.
  test("the lifecycle section shows every stage as a real, tabbed product panel", async ({ page }) => {
    await page.goto("/");
    const section = page.locator("#lifecycle");
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByRole("heading", { name: /the best way to run a rental/i })).toBeVisible();
    for (const kicker of ["Tours", "Applications", "Leasing", "Payments", "Services", "Communication"]) {
      await expect(section.getByText(kicker, { exact: true }).first()).toBeVisible();
    }
    await expect(section.locator("iframe")).toHaveCount(0);

    // Leasing's own in-panel tabs swap which fixture rows render.
    const leasingRow = page.locator('[data-lifecycle-row="leasing"]');
    await expect(leasingRow.getByText("Dana Reyes")).toBeVisible();
    await leasingRow.getByRole("button", { name: /signed/i }).click();
    await expect(leasingRow.getByText("Liam Foster")).toBeVisible();
    await expect(leasingRow.getByText("Dana Reyes")).toHaveCount(0);
  });

  test("nothing overflows sideways on a phone", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 800 } });
    const page = await context.newPage();
    await page.goto("/");
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await context.close();
  });
});
