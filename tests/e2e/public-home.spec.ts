import { test, expect } from "@playwright/test";

test.describe("Public home", () => {
  test("loads the landing hero and both doors", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /the ai does the busywork/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /start free/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /book a demo/i }).first()).toBeVisible();
  });

  test("header carries Pricing and Why PropLane as tabs", async ({ page }) => {
    await page.goto("/");
    const nav = page.locator("#axis-public-navbar");
    await expect(nav.getByRole("link", { name: /^pricing$/i }).first()).toHaveAttribute("href", "/pricing");
    await expect(nav.getByRole("link", { name: /^why proplane$/i }).first()).toHaveAttribute("href", "/why-proplane");
  });

  test("FAQ answers every question ahead of the closing CTA", async ({ page }) => {
    await page.goto("/");

    const faq = page.getByRole("region", { name: "Questions, answered", exact: true });
    await expect(faq).toBeVisible();
    await expect(faq.getByRole("heading", { name: /questions, answered/i })).toBeVisible();

    const rows = faq.locator("details");
    await expect(rows).toHaveCount(7);
    for (const question of [
      "What is PropLane?",
      "What does the AI actually do?",
      "Is there a free plan?",
      "How much does it cost?",
      "Do I need a credit card to try it?",
      "How do my residents get in?",
      "Can I use it on my phone?",
    ]) {
      await expect(faq.getByText(question, { exact: true })).toBeVisible();
    }

    // Opening a row reveals its answer.
    await faq.getByText("Is there a free plan?", { exact: true }).click();
    await expect(faq.getByText(/free is \$0 with no card/i)).toBeVisible();

    // The board sits above the closing CTA.
    const ctaTop = await page
      .getByRole("region", { name: "Get started", exact: true })
      .evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    const faqBottom = await faq.evaluate((el) => el.getBoundingClientRect().bottom + window.scrollY);
    expect(faqBottom).toBeLessThanOrEqual(ctaTop);
  });

  test("pricing teaser reads the three plans from the tier table", async ({ page }) => {
    await page.goto("/");
    const pricing = page.locator("#pricing");
    await pricing.scrollIntoViewIfNeeded();
    await expect(pricing.getByText("$0", { exact: true })).toBeVisible();
    await expect(pricing.getByText("$20", { exact: true })).toBeVisible();
    await expect(pricing.getByText("$200", { exact: true })).toBeVisible();
    await expect(pricing.getByRole("link", { name: /compare every feature/i })).toHaveAttribute("href", "/pricing");
  });

  test("the audience switch changes the screen beside it", async ({ page }) => {
    await page.goto("/");
    const section = page.locator("#who-its-for");
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByRole("tab", { name: /managers/i })).toHaveAttribute("aria-selected", "true");
    await section.getByRole("tab", { name: /residents/i }).click();
    await expect(section.getByRole("link", { name: /for residents/i })).toBeVisible();
    await section.getByRole("tab", { name: /vendors/i }).click();
    await expect(section.getByRole("link", { name: /for vendors/i })).toHaveAttribute("href", "/vendors");
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
