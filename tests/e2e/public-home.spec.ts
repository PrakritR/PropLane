import { test, expect } from "@playwright/test";
import { MANAGER_PLAN_TIERS } from "@/data/manager-plan-tiers";

/** Open the home page and wait for React to hydrate the demo, so a click is never lost to the server HTML. */
async function goHome(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForFunction(() => {
    const node = document.querySelector("#resident-lifecycle-walkthrough button");
    return Boolean(node && Object.keys(node).some((key) => key.startsWith("__reactProps")));
  });
}

test.describe("Public home", () => {
  test("loads the landing hero and both doors", async ({ page }) => {
    await goHome(page);
    await expect(page.getByRole("heading", { level: 1, name: /your ai property management assistant/i })).toBeVisible();
    const hero = page.locator(".rlp-hero");
    await expect(hero.getByRole("link", { name: /start free/i })).toHaveAttribute("href", "/auth/create-account");
    await expect(hero.getByRole("link", { name: /book a demo/i })).toHaveAttribute("href", "/contact?tab=schedule");
    await expect(hero.locator(".rlp-hero-actions a")).toHaveCount(3);
    // Exactly two lines, centered: "Your AI property" over "management assistant."
    const lines = await page.locator(".rlp-hero h1 .rlp-h1-line").evaluateAll((nodes) =>
      nodes.map((node) => ({ text: node.textContent, top: Math.round(node.getBoundingClientRect().top) })),
    );
    expect(lines.map((line) => line.text)).toEqual(["Your AI property", "management assistant."]);
    expect(lines[1]!.top).toBeGreaterThan(lines[0]!.top);
    await expect(page.locator(".rlp-hero h1")).toHaveCSS("text-align", "center");
    // The demo lives in the hero: there is no separate "One conversation" section any more.
    await expect(page.getByRole("heading", { name: /one conversation\. every next step/i })).toHaveCount(0);
  });

  test("the first screen shows the headline, the three buttons and the manager Dashboard", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goHome(page);
    const hero = page.locator(".rlp-hero");
    await expect(hero.getByRole("heading", { level: 1 })).toBeInViewport();
    await expect(hero.locator(".rlp-hero-actions a")).toHaveCount(3);
    for (const link of await hero.locator(".rlp-hero-actions a").all()) await expect(link).toBeInViewport();
    const window = hero.locator("#resident-lifecycle-workspace");
    await expect(window).toBeInViewport({ ratio: 0.6 });
    await expect(hero.getByRole("button", { name: "Dashboard", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(hero.getByText("Welcome back")).toBeInViewport();
    // The sidebar's group label comes before the item it labels.
    const label = await hero.getByText("WORKSPACE", { exact: true }).boundingBox();
    const dashboard = await hero.getByRole("button", { name: "Dashboard", exact: true }).boundingBox();
    expect(label!.y).toBeLessThan(dashboard!.y);
  });

  test("on a phone the headline and buttons come first and the window follows", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await goHome(page);
    const hero = page.locator(".rlp-hero");
    const heading = await hero.getByRole("heading", { level: 1 }).boundingBox();
    const actions = await hero.locator(".rlp-hero-actions").boundingBox();
    const window = await hero.locator("#resident-lifecycle-workspace").boundingBox();
    expect(heading!.y).toBeLessThan(actions!.y);
    expect(actions!.y + actions!.height).toBeLessThanOrEqual(window!.y + 1);
    await context.close();
  });

  test("header carries Pricing and Why PropLane as tabs", async ({ page }) => {
    await goHome(page);
    const nav = page.locator("#axis-public-navbar");
    await expect(nav.getByRole("link", { name: /^pricing$/i }).first()).toHaveAttribute("href", "/pricing");
    await expect(nav.getByRole("link", { name: /^why proplane$/i }).first()).toHaveAttribute("href", "/why-proplane");
  });

  test("FAQ answers every question and closes the page", async ({ page }) => {
    await goHome(page);

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
    await goHome(page);
    const pricing = page.locator("#pricing");
    await pricing.scrollIntoViewIfNeeded();
    for (const tier of MANAGER_PLAN_TIERS) {
      await expect(pricing.getByText(tier.id === "free" ? "$0" : tier.monthly.headline, { exact: true })).toBeVisible();
    }
    await expect(pricing.getByRole("link", { name: /compare every feature/i })).toHaveAttribute("href", "/pricing#compare");
  });

  test.describe("demo engine (account-menu portals, every sidebar tab)", () => {
    test.use({ contextOptions: { reducedMotion: "reduce" } });

    const openDemo = async (page: import("@playwright/test").Page) => {
      await goHome(page);
      const section = page.locator("#resident-lifecycle-walkthrough");
      await section.scrollIntoViewIfNeeded();
      return section;
    };
    const portals: Record<string, { label: string; sidebar: string[] }> = {
      manager: {
        label: "Manager portal",
        sidebar: ["Dashboard", "Properties", "Tours", "Applications", "Leases", "Residents", "Payments", "Services", "Calendar", "Communication", "Vendors"],
      },
      resident: { label: "Resident portal", sidebar: ["My home", "Applications", "Lease", "Payments", "Services", "Forms", "Communication"] },
      vendor: { label: "Vendor portal", sidebar: ["Services", "Calendar", "Payments", "Reviews", "Communication"] },
    };

    test("no stage chrome: no portal switcher, stage tabs, guide line or activity row", async ({ page }) => {
      const section = await openDemo(page);
      await expect(section.getByRole("tablist")).toHaveCount(0);
      await expect(section.locator(".rlp-stage-tabs, .rlp-portal-switch, .rlp-guide-line, .rlp-activity")).toHaveCount(0);
      for (const gone of ["Sample demo", "Explore freely", "Start the story", "Restart guide", "ACTIVITY"]) {
        await expect(section.getByText(gone, { exact: true })).toHaveCount(0);
      }
      // The real portal has no bell, so the demo's top bar has none either.
      await expect(section.getByRole("button", { name: "Notifications" })).toHaveCount(0);
    });

    test("the account menu switches portals, every portal asks PropLane, and every sidebar tab renders a panel", async ({ page }) => {
      const writes: string[] = [];
      page.on("request", (request) => {
        if (request.method() !== "GET" && request.method() !== "HEAD" && request.method() !== "OPTIONS") writes.push(`${request.method()} ${request.url()}`);
      });
      const section = await openDemo(page);
      const topBar = section.locator(".rlp-topbar");
      const menuItem = (name: string) => section.getByRole("menuitem", { name });

      // The menu mirrors the real portal's account menu: the other portals, never the current one.
      await topBar.getByRole("button", { name: "Account menu" }).click();
      await expect(section.getByRole("menu", { name: "Account" })).toBeVisible();
      await expect(menuItem("Switch to Resident portal")).toBeVisible();
      await expect(menuItem("Switch to Vendor portal")).toBeVisible();
      await expect(menuItem("Switch to Property portal")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(section.getByRole("menu")).toHaveCount(0);

      const order = [
        ["manager", null],
        ["resident", "Switch to Resident portal"],
        ["vendor", "Switch to Vendor portal"],
        ["manager", "Switch to Property portal"],
      ] as const;
      for (const [portal, via] of order) {
        if (via) {
          await topBar.getByRole("button", { name: "Account menu" }).click();
          await menuItem(via).click();
        }
        const { label, sidebar } = portals[portal]!;
        const nav = section.getByRole("navigation", { name: `${label} navigation` });
        for (const tab of sidebar) await expect(nav.getByRole("button", { name: tab, exact: true })).toBeVisible();
        // Ask PropLane sits in the top bar of all three portals.
        await expect(topBar.getByRole("button", { name: /Ask PropLane/ })).toBeVisible();
        for (const tab of sidebar) {
          await nav.getByRole("button", { name: tab, exact: true }).click();
          await expect(nav.getByRole("button", { name: tab, exact: true })).toHaveAttribute("aria-current", "page");
          if (portal === "manager" && tab === "Communication") {
            await expect(section.locator(".rlp-live-communication")).toBeVisible();
          } else {
            const frame = section.locator(".rlp-panel-frame[data-demo-panel]");
            await expect(frame).toHaveAttribute("data-demo-panel", new RegExp(`^${portal}:`));
            await expect(frame.locator("> *")).not.toHaveCount(0);
          }
        }
      }
      expect(writes).toEqual([]);
    });

    test("reduced motion never autoplays or grows: the Dashboard stays at full size", async ({ page }) => {
      const section = await openDemo(page);
      await page.mouse.move(2, 2);
      await page.waitForTimeout(4500);
      await expect(section.getByRole("button", { name: "Dashboard", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(page.locator(".rlp-hero-stage")).toHaveCSS("transform", "none");
    });
  });

  test.describe("demo autoplay", () => {
    test.use({ contextOptions: { reducedMotion: "no-preference" } });

    test("plays the story on its own, pauses over the window, and a sidebar click stops it", async ({ page }) => {
      await goHome(page);
      const section = page.locator("#resident-lifecycle-walkthrough");
      await section.scrollIntoViewIfNeeded();
      await page.mouse.move(2, 2);
      const current = section.locator(".rlp-nav-item[aria-current='page']");
      await expect(current).toHaveAttribute("aria-label", "Communication", { timeout: 20_000 });
      await expect(current).toHaveAttribute("aria-label", "Tours", { timeout: 20_000 });
      await section.locator(".rlp-dual-view").hover();
      const held = await current.getAttribute("aria-label");
      await page.waitForTimeout(4500);
      await expect(current).toHaveAttribute("aria-label", held!);
      // A sidebar click is the visitor taking over: leaving the window does not restart the story.
      await section.getByRole("button", { name: "Properties", exact: true }).click();
      await page.mouse.move(2, 2);
      await page.waitForTimeout(4500);
      await expect(current).toHaveAttribute("aria-label", "Properties");
    });

    test("the window grows from 88% to full size over the first 60% of the viewport, with no layout shift", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await goHome(page);
      const scale = () =>
        page.locator(".rlp-hero-stage").evaluate((node) => {
          const match = /matrix\(([^,]+),/.exec(getComputedStyle(node).transform);
          return match ? Number(match[1]) : 1;
        });
      const sectionHeight = () => page.locator("#resident-lifecycle-walkthrough").evaluate((node) => node.getBoundingClientRect().height);
      expect(await scale()).toBeCloseTo(0.88, 2);
      const height = await sectionHeight();
      await page.evaluate(() => window.scrollTo(0, 270));
      await expect.poll(scale).toBeCloseTo(0.94, 1);
      await page.evaluate(() => window.scrollTo(0, 600));
      await expect.poll(scale).toBeCloseTo(1, 2);
      expect(await sectionHeight()).toBe(height);
    });
  });

  test.describe("wavy page background and the blended top bar", () => {
    test.use({ contextOptions: { reducedMotion: "no-preference" } });

    test("the top bar is transparent at the top of the home page and solid once scrolled; other pages keep theirs", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await goHome(page);
      const bar = page.locator("#axis-public-navbar");
      await expect(bar).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(bar).toHaveCSS("border-bottom-width", "0px");
      await page.evaluate(() => window.scrollTo(0, 700));
      await expect(bar).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await page.goto("/pricing");
      await expect(page.locator("#axis-public-navbar")).toHaveCSS("border-bottom-width", "1px");
    });

    test("one wavy background runs behind every section: no white bands", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await goHome(page);
      await expect(page.locator(".home-wavy .rlp-atmosphere--page canvas")).toHaveCount(1);
      const bands = await page.locator(".home-wavy section").evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).backgroundColor).filter((color) => color !== "rgba(0, 0, 0, 0)"),
      );
      expect(bands).toEqual([]);
      await expect(page.locator(".lrf-stage").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(page.locator("footer").last()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    });
  });

  // The demo autoplays; to step through it by hand, wait for the story to start, then hover the
  // window: hovering pauses autoplay and the highlighted button is the guide.
  test.describe("guided sample (clicking each highlighted step)", () => {
    test.use({ contextOptions: { reducedMotion: "no-preference" } });

    const startGuided = async (page: import("@playwright/test").Page) => {
      await goHome(page);
      const section = page.locator("#resident-lifecycle-walkthrough");
      await section.scrollIntoViewIfNeeded();
      await page.mouse.move(2, 2);
      await expect(section.locator('[data-guide-target="suggest"]')).toHaveAttribute("data-guide-active", "true", { timeout: 20_000 });
      await section.locator(".rlp-dual-view").hover();
      return section;
    };

    test("the homepage guides the local sample from reply through service", async ({ page }) => {
      const section = await startGuided(page);
      for (const target of ["suggest", "send", "accept-tour", "approve", "send-lease", "open-lease", "resident-sign", "manager-sign", "service"]) {
        const action = section.locator(`[data-guide-target="${target}"]`);
        await expect(action).toHaveAttribute("data-guide-active", "true");
        await action.click();
      }
      await expect(section.getByText("Manager signature pending").first()).toBeVisible();
    });

    test("busy transitions preserve drafts and the signing preview", async ({ page }) => {
      const section = await startGuided(page);
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
      await expect(section.getByRole("button", { name: "Services", exact: true })).toHaveAttribute("aria-current", "page");
    });

    test("a phone reply submitted during a chapter transition is kept", async ({ page }) => {
      const section = await startGuided(page);
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
    await goHome(page);
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await context.close();
  });
});
