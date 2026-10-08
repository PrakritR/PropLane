import { test, expect } from "@playwright/test";
import { MANAGER_PLAN_TIERS } from "@/data/manager-plan-tiers";

/** Open the home page and wait for React to hydrate the demo, so a click is never lost to the server HTML. */
async function goHome(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForFunction(() => {
    const node = document.querySelector("#rlp-demo-stage button");
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
    const demo = page.locator("#rlp-demo-stage");
    await expect(demo).toBeInViewport({ ratio: 0.6 });
    await expect(demo.getByRole("button", { name: "Dashboard", exact: true })).toHaveAttribute("aria-current", "page");
    // The Dashboard is the real one: its first row is the KPI cards, and it has no "Welcome back" heading.
    await expect(demo.getByText("Occupancy", { exact: true })).toBeInViewport();
    await expect(demo.getByText("Welcome back")).toHaveCount(0);
    // The sidebar's group label comes before the item it labels.
    const label = await demo.getByRole("button", { name: "Leasing group", exact: true }).boundingBox();
    const tours = await demo.getByRole("button", { name: "Tours", exact: true }).boundingBox();
    expect(label!.y).toBeLessThan(tours!.y);
    // The phone is on the first screen too, captioned by role.
    await expect(page.getByText("Resident's phone", { exact: true })).toBeInViewport();
  });

  test("on a phone the headline and buttons come first and the window follows", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await goHome(page);
    const hero = page.locator(".rlp-hero");
    const heading = await hero.getByRole("heading", { level: 1 }).boundingBox();
    const actions = await hero.locator(".rlp-hero-actions").boundingBox();
    const window = await page.locator("#rlp-demo-stage .rlp-workspace").boundingBox();
    const phone = await page.locator(".rlp-story-phone-slot").boundingBox();
    expect(heading!.y).toBeLessThan(actions!.y);
    expect(actions!.y + actions!.height).toBeLessThanOrEqual(window!.y + 1);
    // Below the large-screen breakpoint the phone is inline, right under the window, not pinned.
    expect(phone!.y).toBeGreaterThanOrEqual(window!.y + window!.height - 1);
    await expect(page.locator(".rlp-story-phone-slot")).toHaveCSS("position", "static");
    await context.close();
  });

  test("the hero pins the headline while the window grows with the scroll, then the page scrolls on", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goHome(page);
    const scale = () => page.locator(".rlp-hero-stage").evaluate((node) => new DOMMatrix(getComputedStyle(node).transform).a);
    const headingTop = () => page.locator(".rlp-hero h1").evaluate((node) => Math.round(node.getBoundingClientRect().top));
    const scrollTo = async (y: number) => {
      await page.evaluate((to) => window.scrollTo(0, to), y);
      await page.waitForTimeout(350);
    };
    const start = await scale();
    const top = await headingTop();
    expect(start).toBeLessThan(0.8);
    // Mid-run: the headline has not moved and the window is bigger than it was.
    await scrollTo(900 * 0.3);
    const mid = await scale();
    expect(mid).toBeGreaterThan(start + 0.02);
    expect(mid).toBeLessThan(1);
    expect(await headingTop()).toBe(top);
    // At the end of the run the window is full size and the headline is still pinned.
    await scrollTo(900 * 0.7);
    expect(await scale()).toBeCloseTo(1, 2);
    expect(await headingTop()).toBe(top);
    // Past it the page scrolls on normally: the headline leaves with the frame.
    await scrollTo(900 * 0.7 + 420);
    expect(await headingTop()).toBeLessThan(top - 300);
    expect(await scale()).toBeCloseTo(1, 2);
  });

  test("on a phone the hero is static: the window is full size at the top and nothing is pinned", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await goHome(page);
    await expect(page.locator(".rlp-hero-stage")).toHaveCSS("transform", "none");
    await expect(page.locator(".rlp-grow-frame")).toHaveCSS("position", "static");
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
      const section = page.locator("#rlp-demo-stage");
      await section.scrollIntoViewIfNeeded();
      return section;
    };
    const portals: Record<string, { label: string; sidebar: string[] }> = {
      manager: {
        label: "Manager portal",
        // The real manager sidebar, row for row (`PORTAL_NAV_GROUPS`; tests/unit/home-demo-nav-parity.test.ts).
        sidebar: [
          "Dashboard", "Tasks", "Calendar", "Communication",
          "Properties", "Bookings", "Promotion",
          "Tours", "Application", "Leases", "Forms",
          "Residents", "Vendors", "Services",
          "Incoming payments", "Outgoing payments", "Finances", "Documents",
        ],
      },
      resident: {
        label: "Resident portal",
        sidebar: ["Dashboard", "Communication", "My home", "Lease", "Forms", "Services", "Tour", "Application", "Payments", "Documents"],
      },
      vendor: { label: "Vendor portal", sidebar: ["Dashboard", "Communication", "Calendar", "Services", "Reviews", "Finances", "Documents"] },
    };

    test("no stage chrome: no portal switcher, stage tabs, guide line or activity row", async ({ page }) => {
      const section = await openDemo(page);
      // The first beat opens Communication, whose own Active / Archived folders (the real list header) are the only tab strip on screen.
      await expect(section.getByRole("navigation", { name: "Conversation folders" })).toHaveCount(1);
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
      await section.getByRole("button", { name: "Account menu" }).click();
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
          await section.getByRole("button", { name: "Account menu" }).click();
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
            await expect(section.locator(".rlp-comm-body")).toBeVisible();
          } else {
            const frame = section.locator(".rlp-panel-frame[data-demo-panel]");
            await expect(frame).toHaveAttribute("data-demo-panel", new RegExp(`^${portal}:`));
            await expect(frame.locator("> *")).not.toHaveCount(0);
          }
        }
      }
      expect(writes).toEqual([]);
    });

    test("reduced motion never autoplays or grows: the first beat stays, at full size", async ({ page }) => {
      const section = await openDemo(page);
      await page.mouse.move(2, 2);
      await page.waitForTimeout(4500);
      await expect(section.getByRole("button", { name: "Communication", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(page.locator(".rlp-hero-stage")).toHaveCSS("transform", "none");
      // Still means still: no cursor is drawn, and nothing moves on its own.
      await expect(page.locator(".rlp-cursor")).toHaveCount(0);
      await expect(section).toHaveAttribute("data-demo-cursor", "off");
      // The phone shows the first beat, still: no typing indicator.
      await expect(page.locator("[data-phone-typing]")).toHaveCount(0);
      await expect(page.locator(".rlp-story-phone .rl-phone-message")).toHaveCount(2);
    });
  });

  test.describe("demo autoplay", () => {
    test.use({ contextOptions: { reducedMotion: "no-preference" } });

    test("plays the four beats on its own, pauses over the window, and a sidebar click pins the tab", async ({ page }) => {
      test.slow();
      await goHome(page);
      const demo = page.locator("#rlp-demo-stage");
      await demo.scrollIntoViewIfNeeded();
      await page.mouse.move(2, 2);
      const current = demo.locator(".rlp-nav-item[aria-current='page']");
      await expect(current).toHaveAttribute("aria-label", "Dashboard");
      // Beat 1: the prospect texts and the manager approves the reply in Communication; beat 2: Applications.
      await expect(current).toHaveAttribute("aria-label", "Communication", { timeout: 20_000 });
      await expect(demo).toHaveAttribute("data-demo-beat", "0");
      await expect(current).toHaveAttribute("aria-label", "Application", { timeout: 30_000 });
      await expect(demo).toHaveAttribute("data-demo-beat", "1");
      // Hovering the window pauses the story.
      await demo.hover();
      const held = await current.getAttribute("aria-label");
      await page.waitForTimeout(4500);
      await expect(current).toHaveAttribute("aria-label", held!);
      // A sidebar click is the visitor taking over: the tab stays, and leaving the window does not move it.
      await demo.getByRole("button", { name: "Properties", exact: true }).click();
      await page.mouse.move(2, 2);
      await page.waitForTimeout(4500);
      await expect(current).toHaveAttribute("aria-label", "Properties");
    });

    test("the story is manager-led: a cursor clicks Send application, and only then does the phone get the apply link", async ({ page }) => {
      test.slow();
      await goHome(page);
      const demo = page.locator("#rlp-demo-stage");
      const phone = page.locator(".rlp-story-phone");
      const link = phone.getByText("Apply for Room 3 — PropLane");
      await demo.scrollIntoViewIfNeeded();
      await page.mouse.move(2, 2);
      // The Manager cursor appears, opens Communication and approves PropLane's drafted reply: the tour lands on the phone.
      await expect(page.locator(".rlp-cursor[data-visible='true'] .rlp-cursor-label")).toHaveText("Manager", { timeout: 20_000 });
      await expect(demo.getByText("PropLane draft - edit before sending")).toBeVisible({ timeout: 20_000 });
      await expect(phone.getByText("Thursday, 5:30 PM")).toHaveCount(0);
      await expect(phone.getByText("Thursday, 5:30 PM")).toBeVisible({ timeout: 15_000 });
      // It opens Applications and clicks Send application. The link is not on the phone until that click has happened.
      const sheet = demo.getByRole("dialog", { name: "Send application" });
      await expect(sheet).toBeVisible({ timeout: 30_000 });
      await expect(link).toHaveCount(0);
      // The cursor sends it: the sheet closes and the link card arrives on the resident's phone.
      await expect(sheet).toBeHidden({ timeout: 15_000 });
      await expect(link).toBeVisible({ timeout: 15_000 });
      // The resident applies: the new pending application shows in the window, and the cursor opens it to approve.
      await expect(demo.getByText("jordan@example.com")).toBeVisible({ timeout: 20_000 });
      const approve = demo.getByRole("dialog", { name: "Jordan" });
      await expect(approve).toBeVisible({ timeout: 20_000 });
      await expect(approve.getByRole("button", { name: "Approve" })).toBeVisible();
      await expect(approve).toBeHidden({ timeout: 15_000 });
    });

    test("hovering the window pauses the cursor, and it stays inside the window, never over the phone", async ({ page }) => {
      test.slow();
      await goHome(page);
      const demo = page.locator("#rlp-demo-stage");
      await demo.scrollIntoViewIfNeeded();
      await page.mouse.move(2, 2);
      const cursor = page.locator(".rlp-cursor");
      await expect(cursor).toHaveAttribute("data-visible", "true", { timeout: 20_000 });
      const inside = async () => {
        const stage = (await demo.boundingBox())!;
        const at = (await cursor.boundingBox())!;
        return at.x >= stage.x - 2 && at.x <= stage.x + stage.width + 2 && at.y >= stage.y - 2 && at.y <= stage.y + stage.height + 2;
      };
      expect(await inside()).toBe(true);
      await demo.hover({ position: { x: 600, y: 30 } });
      await page.waitForTimeout(1800);
      const first = await cursor.boundingBox();
      await page.waitForTimeout(2500);
      const second = await cursor.boundingBox();
      expect(second).toEqual(first);
      expect(await inside()).toBe(true);
    });

    test("the phone is always typing: a typing indicator, then the message, then the next one", async ({ page }) => {
      test.slow();
      await goHome(page);
      const phone = page.locator(".rlp-story-phone");
      await page.mouse.move(2, 2);
      const messages = phone.locator(".rl-phone-message:not(.rl-phone-typing)");
      await expect(phone.locator("[data-phone-typing]")).toBeVisible();
      await expect(messages).toHaveCount(1, { timeout: 15_000 });
      await expect(phone.locator("[data-phone-typing]")).toBeVisible({ timeout: 10_000 });
      await expect(messages).toHaveCount(2, { timeout: 15_000 });
      // Four beats, one or two messages each, then it starts over.
      await expect(phone.getByText("Today", { exact: true })).toBeVisible();
    });

    test("the phone stays on screen through the demo and every lifecycle row, captioned by role", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await goHome(page);
      const slot = page.locator(".rlp-story-phone-slot");
      await expect(slot).toHaveCSS("position", "sticky");
      await expect(page.getByText("Resident's phone", { exact: true })).toBeInViewport();
      const rows = page.locator("[data-lifecycle-row]");
      const count = await rows.count();
      expect(count).toBeGreaterThan(5);
      // Captain, Oct 7: the phone is vertically centred in the viewport, on the right, and stays there.
      const centred = async () => {
        const box = (await page.locator(".rlp-story-phone").boundingBox())!;
        const viewport = page.viewportSize()!;
        expect(box.x + box.width / 2).toBeGreaterThan(viewport.width * 0.7);
        expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThan(viewport.height * 0.12);
      };
      for (const y of [0, 800, 2400]) {
        await page.evaluate((top) => window.scrollTo(0, top), y);
        await page.waitForTimeout(300);
        await centred();
      }
      for (const index of [0, 3, count - 1]) {
        await rows.nth(index).scrollIntoViewIfNeeded();
        await expect(slot).toBeInViewport({ ratio: 0.9 });
      }
      // No sample names on the phone or the window chrome: people are shown by role.
      const chrome = await page.locator("#rlp-demo-stage .rlp-topbar, .rlp-story-phone").allTextContents();
      expect(chrome.join(" ")).not.toMatch(/Avery|Morgan|Marcus|Rivera/);
    });

    test("every window has one fixed height: hero in every portal, and every row", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await goHome(page);
      const demo = page.locator("#rlp-demo-stage");
      const height = () => demo.locator(".rlp-workspace").evaluate((node) => Math.round(node.getBoundingClientRect().height));
      const fixed = await height();
      await page.mouse.move(2, 2);
      for (const [via, tabs] of [
        [null, ["Dashboard", "Properties", "Communication", "Leases"]],
        ["Switch to Resident portal", ["My home", "Payments", "Communication"]],
        ["Switch to Vendor portal", ["Dashboard", "Services", "Calendar"]],
      ] as const) {
        if (via) {
          await demo.getByRole("button", { name: "Account menu" }).click();
          await page.getByRole("menuitem", { name: via }).click();
        }
        for (const tab of tabs) {
          await demo.getByRole("button", { name: tab, exact: true }).click();
          expect(await height(), `${via ?? "Manager"} ${tab}`).toBe(fixed);
        }
      }
      // The screen scrolls inside the window when it is longer than the window.
      await demo.getByRole("button", { name: "Account menu" }).click();
      await page.getByRole("menuitem", { name: /Switch to Property portal/ }).click();
      await demo.getByRole("button", { name: "Dashboard", exact: true }).click();
      const scrolls = await demo.locator(".rlp-canvas-panel").evaluate((node) =>
        [node, ...Array.from(node.querySelectorAll("*"))].some(
          (el) => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY),
        ),
      );
      expect(scrolls).toBe(true);
      const rowHeights = await page.locator(".lrf-window").evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
      expect(rowHeights.length).toBeGreaterThan(5);
      expect(new Set(rowHeights).size).toBe(1);
    });

    test("the focus ring on a sidebar item stays inside the sidebar", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await goHome(page);
      const demo = page.locator("#rlp-demo-stage");
      const item = demo.getByRole("button", { name: "Communication", exact: true });
      await item.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(item).toBeFocused();
      const ring = await item.evaluate((node) => {
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        const sidebar = node.closest(".rlp-sidebar")!.getBoundingClientRect();
        const reach = style.outlineStyle === "none" ? 0 : Math.max(0, parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth));
        return { left: box.left - reach - sidebar.left, right: sidebar.right - (box.right + reach), outlineStyle: style.outlineStyle };
      });
      expect(ring.outlineStyle).not.toBe("none");
      expect(ring.left).toBeGreaterThanOrEqual(0);
      expect(ring.right).toBeGreaterThanOrEqual(0);
    });

    test("the phone follows the portal: Manager's phone for the resident, Vendor's phone for the vendor", async ({ page }) => {
      test.slow();
      await goHome(page);
      const demo = page.locator("#rlp-demo-stage");
      await page.mouse.move(2, 2);
      for (const [via, caption, role] of [
        ["Switch to Resident portal", "Manager's phone", "Resident"],
        ["Switch to Vendor portal", "Vendor's phone", "Vendor"],
        ["Switch to Property portal", "Resident's phone", "Manager"],
      ] as const) {
        await demo.getByRole("button", { name: "Account menu" }).click();
        // The account card names the role the window is in, not a person.
        const expectedHere = role === "Resident" ? "Manager" : role === "Vendor" ? "Resident" : "Vendor";
        await expect(demo.locator(".rlp-account-card strong")).toHaveText(expectedHere);
        await page.getByRole("menuitem", { name: via }).click();
        await expect(page.getByText(caption, { exact: true })).toBeVisible();
      }
      // Choosing a portal from the menu must not freeze the story: the phone keeps typing and landing messages.
      await page.mouse.move(2, 2);
      await expect(page.locator(".rlp-story-phone .rl-phone-message:not(.rl-phone-typing)").first()).toBeVisible({ timeout: 15_000 });
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
      // Page sections only: the product windows (and the cards inside them) draw their own surfaces.
      const bands = await page.locator(".home-wavy section").evaluateAll((nodes) =>
        nodes
          .filter((node) => !node.closest(".rlp-workspace, .rl-phone-wrap"))
          .map((node) => getComputedStyle(node).backgroundColor)
          .filter((color) => color !== "rgba(0, 0, 0, 0)"),
      );
      expect(bands).toEqual([]);
      await expect(page.locator(".lrf-stage").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(page.locator("footer").last()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    });
  });

  test.describe("nothing is cut off", () => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      test(`the Replaces strip shows every item whole and the import window ends on its last card at ${viewport.width}px`, async ({ browser }) => {
        const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
        const page = await context.newPage();
        await goHome(page);
        // Every Replaces item sits inside the strip: nothing runs past its right edge.
        const strip = page.locator("ul", { has: page.getByText("a ledger") });
        await strip.scrollIntoViewIfNeeded();
        const box = (await strip.boundingBox())!;
        for (const item of await strip.locator("li").all()) {
          const at = (await item.boundingBox())!;
          expect(at.x + at.width, "item ends inside the strip").toBeLessThanOrEqual(box.x + box.width + 1);
        }
        // The import window is drawn whole, with room below it inside its frame.
        const frame = page.locator(".sw-import-frame");
        await frame.scrollIntoViewIfNeeded();
        const frameBox = (await frame.boundingBox())!;
        const windowBox = (await frame.locator(".pm-window").boundingBox())!;
        expect(windowBox.y + windowBox.height).toBeLessThanOrEqual(frameBox.y + frameBox.height - 8);
        // Nothing inside the window scrolls: the last card is not clipped by an inner scroller.
        const clipped = await frame.evaluate((node) =>
          [...node.querySelectorAll<HTMLElement>("*")].some(
            (el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1,
          ),
        );
        expect(clipped).toBe(false);
        await context.close();
      });
    }

    test("a window that scrolls says so: a fade and a chevron at the bottom while more is below", async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      const page = await context.newPage();
      await goHome(page);
      const demo = page.locator("#rlp-demo-stage");
      await demo.scrollIntoViewIfNeeded();
      await demo.getByRole("button", { name: "Application", exact: true }).click();
      const main = demo.locator(".rlp-main");
      await expect(main).toHaveAttribute("data-scroll", /more|end/);
      const fade = async () => Number(await main.evaluate((node) => getComputedStyle(node, "::after").opacity));
      // The fade is on exactly while the screen has more below it.
      await expect.poll(async () => ((await main.getAttribute("data-scroll")) === "more" ? 1 : 0)).toBe(await fade());
      await context.close();
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
