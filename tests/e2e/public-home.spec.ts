import { test, expect } from "@playwright/test";
import { MANAGER_PLAN_TIERS } from "@/data/manager-plan-tiers";

test.describe("Public home", () => {
  test("loads the landing hero and both doors", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: /from first question to feeling at home/i })).toBeVisible();
    const hero = page.locator(".rlp-hero");
    await expect(hero.getByRole("link", { name: /start free/i })).toHaveAttribute("href", "/auth/create-account");
    await expect(hero.getByRole("link", { name: /book a demo/i })).toHaveAttribute("href", "/contact?tab=schedule");
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

  test.describe("demo engine (portals, stages, every sidebar tab)", () => {
    test.use({ contextOptions: { reducedMotion: "reduce" } });

    const openDemo = async (page: import("@playwright/test").Page) => {
      await page.goto("/");
      const section = page.locator("#resident-lifecycle-walkthrough");
      await section.scrollIntoViewIfNeeded();
      return section;
    };
    const stageNames: Record<string, string[]> = {
      "Manager portal": ["Message", "Tour", "Application", "Lease", "Move in", "Rent", "Repair"],
      "Resident portal": ["Apply", "Sign", "Pay", "Request", "Forms"],
      "Vendor portal": ["Offer", "Quote", "Visit", "Paid"],
    };
    const sidebars: Record<string, string[]> = {
      "Manager portal": ["Dashboard", "Properties", "Tours", "Applications", "Leases", "Residents", "Payments", "Services", "Calendar", "Communication", "Vendors"],
      "Resident portal": ["My home", "Applications", "Lease", "Payments", "Services", "Forms", "Communication"],
      "Vendor portal": ["Services", "Calendar", "Payments", "Reviews", "Communication"],
    };

    test("the portal switcher swaps stages, sidebar and phone, and every sidebar tab renders a panel", async ({ page }) => {
      const writes: string[] = [];
      page.on("request", (request) => {
        if (request.method() !== "GET" && request.method() !== "HEAD" && request.method() !== "OPTIONS") writes.push(`${request.method()} ${request.url()}`);
      });
      const section = await openDemo(page);
      const portals = section.getByRole("tablist", { name: "Portal", exact: true });
      await expect(portals.getByRole("tab")).toHaveCount(3);
      for (const portal of Object.keys(stageNames)) {
        await portals.getByRole("tab", { name: portal }).click();
        await expect(portals.getByRole("tab", { name: portal })).toHaveAttribute("aria-selected", "true");
        const stages = section.getByRole("tablist", { name: `${portal} stages` });
        for (const stage of stageNames[portal]!) await expect(stages.getByRole("tab", { name: new RegExp(`${stage}$`) })).toBeVisible();
        await expect(stages.getByRole("tab")).toHaveCount(stageNames[portal]!.length);
        const nav = section.getByRole("navigation", { name: `${portal} navigation` });
        for (const tab of sidebars[portal]!) await expect(nav.getByRole("button", { name: tab, exact: true })).toBeVisible();
        // Every sidebar item opens a panel and becomes the current page.
        for (const tab of sidebars[portal]!) {
          await nav.getByRole("button", { name: tab, exact: true }).click();
          await expect(nav.getByRole("button", { name: tab, exact: true })).toHaveAttribute("aria-current", "page");
          if (portal === "Manager portal" && tab === "Communication") {
            await expect(section.locator(".rlp-live-communication")).toBeVisible();
          } else {
            const frame = section.locator("[data-demo-panel]");
            await expect(frame).toHaveAttribute("data-demo-panel", new RegExp(`^${portal.split(" ")[0]!.toLowerCase()}:`));
            await expect(frame.locator("> *")).not.toHaveCount(0);
          }
        }
      }
      // The resident and vendor portals show their own phones.
      await expect(section.getByText("Marcus’s phone").first()).toBeVisible();
      expect(writes).toEqual([]);
    });

    test("a stage tab jumps there and the sidebar follows; arrow keys move between tabs", async ({ page }) => {
      const section = await openDemo(page);
      const stages = section.getByRole("tablist", { name: "Manager portal stages" });
      await stages.getByRole("tab", { name: /Lease$/ }).click();
      await expect(stages.getByRole("tab", { name: /Lease$/ })).toHaveAttribute("aria-selected", "true");
      await expect(section.getByRole("button", { name: "Leases", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(section.locator('[data-guide-target="send-lease"]')).toHaveAttribute("data-guide-active", "true");
      await stages.getByRole("tab", { name: /Message$/ }).click();
      await stages.getByRole("tab", { name: /Message$/ }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(stages.getByRole("tab", { name: /Tour$/ })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(stages.getByRole("tab", { name: /Tour$/ })).toHaveAttribute("aria-selected", "true");
      await expect(section.getByRole("button", { name: "Tours", exact: true })).toHaveAttribute("aria-current", "page");
    });

    test("reduced motion never autoplays", async ({ page }) => {
      const section = await openDemo(page);
      await page.mouse.move(2, 2);
      await page.waitForTimeout(4500);
      await expect(section.getByRole("tab", { name: /Message$/ })).toHaveAttribute("aria-selected", "true");
      await expect(section.locator('[data-guide-target="suggest"]')).toHaveAttribute("data-guide-active", "true");
    });
  });

  test.describe("demo autoplay", () => {
    test.use({ contextOptions: { reducedMotion: "no-preference" } });

    test("plays each step on its own, and pauses while the pointer is over the stage", async ({ page }) => {
      await page.goto("/");
      const section = page.locator("#resident-lifecycle-walkthrough");
      await section.scrollIntoViewIfNeeded();
      await page.mouse.move(2, 2);
      const selected = section.locator('.rlp-stage-tabs [aria-selected="true"]');
      await expect(selected).toContainText("Tour", { timeout: 20_000 });
      await section.locator(".rlp-dual-view").hover();
      const held = (await selected.textContent()) ?? "";
      await page.waitForTimeout(4500);
      await expect(selected).toHaveText(held);
      await page.mouse.move(2, 2);
      await expect(selected).not.toHaveText(held, { timeout: 15_000 });
    });
  });

  // The demo autoplays; reduced motion turns that off, so the highlighted button is the
  // only thing that moves the story and these steps are deterministic.
  test.describe("guided sample (clicking each highlighted step)", () => {
    test.use({ contextOptions: { reducedMotion: "reduce" } });

    test("the homepage guides the local sample from reply through service and can replay", async ({ page }) => {
      await page.goto("/");
      const section = page.locator("#resident-lifecycle-walkthrough");
      await section.scrollIntoViewIfNeeded();
      await expect(section.getByText("Sample demo")).toBeVisible();
      for (const target of ["suggest", "send", "accept-tour", "approve", "send-lease", "open-lease", "resident-sign", "manager-sign", "service"]) {
        const action = section.locator(`[data-guide-target="${target}"]`);
        await expect(action).toHaveAttribute("data-guide-active", "true");
        await action.click();
      }
      await expect(section.getByText("Jordan’s request reached the manager")).toBeVisible();
      await section.getByRole("button", { name: "Replay" }).click();
      await expect(section.locator('[data-guide-target="suggest"]')).toHaveAttribute("data-guide-active", "true");
    });

    test("busy transitions preserve drafts and the signing preview, then replay cancels timers", async ({ page }) => {
      await page.goto("/");
      const section = page.locator("#resident-lifecycle-walkthrough");
      const action = (target: string) => section.locator(`[data-guide-target="${target}"]`);
      const draft = section.locator(".rlp-compose input[aria-label='Write a reply']");
      const prepared = "Yes, Room 3 is available. Thursday at 5:30 PM Pacific is offered for a tour. Reply YES to confirm that time.";

      await action("suggest").click();
      await expect(draft).toHaveValue(prepared);
      await expect(action("send")).toBeDisabled();
      await draft.evaluate((input: HTMLInputElement) => input.form?.requestSubmit());
      await expect(draft).toHaveValue(prepared);
      await expect(action("send")).toHaveAttribute("data-guide-active", "true");
      await action("send").click();
      await expect(section.locator(".rlp-bubble-manager", { hasText: prepared })).toHaveCount(1);
      await expect(section.locator(".rl-phone-incoming", { hasText: prepared })).toHaveCount(1);
      await expect(action("accept-tour")).toHaveAttribute("data-guide-active", "true");

      for (const [target, next] of [["accept-tour", "approve"], ["approve", "send-lease"], ["send-lease", "open-lease"]] as const) {
        await action(target).click();
        await expect(action(next)).toHaveAttribute("data-guide-active", "true");
      }
      await action("open-lease").click();
      await expect(action("resident-sign")).toBeDisabled();
      await expect(section.locator(".rl-phone-signing-preview")).toBeVisible();
      await expect(action("resident-sign")).toHaveAttribute("data-guide-active", "true");
      await action("resident-sign").click();
      await expect(section.getByText("Manager signature pending").first()).toBeVisible();
      await expect(action("manager-sign")).toHaveAttribute("data-guide-active", "true");
      await action("manager-sign").click();
      await expect(action("service")).toHaveAttribute("data-guide-active", "true");
      await action("service").click();
      await expect(section.getByText("Jordan’s request reached the manager")).toBeVisible();

      await section.getByRole("button", { name: "Replay" }).click();
      await action("suggest").click();
      await section.getByRole("button", { name: "Explore freely" }).click();
      await section.getByRole("button", { name: "Restart guide" }).click();
      await page.waitForTimeout(1100);
      await expect(action("suggest")).toHaveAttribute("data-guide-active", "true");
      await expect(draft).toBeEmpty();
      await expect(section.locator(".rlp-bubble-manager", { hasText: prepared })).toHaveCount(0);
    });

    test("a phone reply submitted during a chapter transition is kept", async ({ page }) => {
      await page.goto("/");
      const section = page.locator("#resident-lifecycle-walkthrough");
      const action = (target: string) => section.locator(`[data-guide-target="${target}"]`);
      const reply = "I can visit Thursday after work.";
      const phoneComposer = section.locator(".rl-phone-composer");

      await action("suggest").click();
      await expect(action("send")).toHaveAttribute("data-guide-active", "true");
      await phoneComposer.getByRole("textbox", { name: "Write a reply" }).fill(reply);
      await action("send").click();
      await expect(action("send")).toBeDisabled();
      await phoneComposer.evaluate((form: HTMLFormElement) => form.requestSubmit());
      await expect(action("accept-tour")).toHaveAttribute("data-guide-active", "true");
      await expect(section.locator(".rl-phone-outgoing", { hasText: reply })).toHaveCount(1);
    });
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
