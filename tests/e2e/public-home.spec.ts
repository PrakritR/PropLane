import { test, expect } from "@playwright/test";

test.describe("Public home", () => {
  test("loads the landing hero and CTAs", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /the ai does the busywork/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /get started for free/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /book a demo/i }).first()).toBeVisible();
  });

  test("FAQ post-it board renders every note ahead of the closing CTA", async ({ page }) => {
    await page.goto("/");

    // React streams a hidden S:1 copy before hydration installs the page.
    // The accessible region excludes that transport copy while still failing
    // if the rendered page contains duplicate FAQ sections.
    const faq = page.getByRole("region", { name: "Questions, answered", exact: true });
    await expect(faq).toBeVisible();
    await expect(faq.getByRole("heading", { name: /questions, answered/i })).toBeVisible();

    // Every note is a question/answer pair in the description list.
    const notes = faq.locator(".lp-note");
    await expect(notes).toHaveCount(7);
    await expect(faq.locator("dt.lp-note-q")).toHaveCount(7);
    await expect(faq.locator("dd.lp-note-a")).toHaveCount(7);
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

    // The board sits between the ops banner and the closing CTA.
    const ctaTop = await page
      .getByRole("region", { name: "Get started", exact: true })
      .evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    const faqBottom = await faq.evaluate((el) => el.getBoundingClientRect().bottom + window.scrollY);
    expect(faqBottom).toBeLessThanOrEqual(ctaTop);
  });

  test("sticky notes rest tilted and straighten on hover", async ({ page }) => {
    await page.goto("/");
    const note = page.getByRole("region", { name: "Questions, answered", exact: true }).locator(".lp-note").nth(1);
    await note.scrollIntoViewIfNeeded();

    const resting = await note.evaluate((el) => getComputedStyle(el).transform);
    expect(resting).not.toBe("none");
    expect(resting).not.toBe("matrix(1, 0, 0, 1, 0, 0)");

    await note.hover();
    // rotate(0deg) translateY(-4px), polled: the 0.22s transition can outlast a
    // fixed sleep on a loaded runner, and a one-shot read has nothing to retry.
    await expect(note).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, -4)");
  });

  test("reduced motion freezes the note tilt on hover", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("/");
    const note = page.getByRole("region", { name: "Questions, answered", exact: true }).locator(".lp-note").nth(1);
    await note.scrollIntoViewIfNeeded();

    const resting = await note.evaluate((el) => getComputedStyle(el).transform);
    await note.hover();
    // Settle past the 0.22s transition this rule is supposed to suppress, then
    // assert the tilt never moved.
    await page.waitForTimeout(400);
    await expect(note).toHaveCSS("transform", resting);
    await context.close();
  });

  test("FAQ board collapses to one readable column on a phone", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 800 } });
    const page = await context.newPage();
    await page.goto("/");

    const faq = page.getByRole("region", { name: "Questions, answered", exact: true });
    const board = faq.locator(".lp-faq-board");
    await board.scrollIntoViewIfNeeded();
    const columns = await board.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    expect(columns).toBe(1);

    const overflowing = await faq
      .locator(".lp-note")
      .evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).length);
    expect(overflowing).toBe(0);
    await context.close();
  });
});
