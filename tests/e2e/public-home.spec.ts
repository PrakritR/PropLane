import { test, expect, type Page, type Request } from "@playwright/test";
import {
  BOOK_DEMO_HREF,
  BOOK_DEMO_NOTE,
  GET_STARTED_HREF,
  MANAGER_GET_STARTED_HREF,
  RESIDENT_GET_STARTED_HREF,
  VENDOR_GET_STARTED_HREF,
} from "@/lib/marketing/public-contact";
import { HOME_ROLES } from "@/lib/marketing/home-roles";

/**
 * The homepage as it ships (captain rounds #12-#31): the texting cover, How it works, the Software demo (an iframe of
 * the real portals), Service, Pricing, Contact and Join free, with a phone layout of hero + Contact + Join free +
 * footer only. Assertions are structural (ids, roles, hrefs), never marketing sentences, so the release gate fails
 * when the page breaks, not when copy is rewritten.
 */

/** Open the home page and wait for React to hydrate the top bar, so a click is never lost to the server HTML. */
async function goHome(page: Page, path = "/") {
  await page.goto(path);
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-attr="home-nav-book-demo-desktop"]');
    return Boolean(node && Object.keys(node).some((key) => key.startsWith("__reactProps")));
  });
}

const horizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const shown = (page: Page, selector: string) =>
  page.evaluate((s) => [...document.querySelectorAll(s)].some((node) => node.getClientRects().length > 0), selector);

test.describe("Public home", () => {
  test("the cover: the headline and one text-us action, never Start free", async ({ page }) => {
    await goHome(page);
    await expect(page.locator("#home-title").first()).toBeVisible();
    const action = page.locator('[data-attr="home-text-proplane"]');
    await expect(action).toBeVisible();
    await expect(action).toHaveText(/^Text /);
    // The configured public line is an sms: link; with no line at all the same button opens Contact.
    expect(await action.getAttribute("href")).toMatch(/^sms:|^\/#contact$/);
    await expect(page.locator("#home-hero")).not.toContainText("Start free");
  });

  test("the role strip sends each audience to its own start (Managers and Owners to the Property sign-up)", async ({ page }) => {
    await goHome(page);
    const strip = page.getByRole("list", { name: "Who texts PropLane" });
    const expected: Record<string, string> = {
      prospects: "/rent/browse",
      residents: RESIDENT_GET_STARTED_HREF,
      vendors: VENDOR_GET_STARTED_HREF,
      managers: MANAGER_GET_STARTED_HREF,
      owners: MANAGER_GET_STARTED_HREF,
    };
    const links = strip.getByRole("link");
    await expect(links).toHaveText(HOME_ROLES.map((role) => role.label));
    for (const [index, role] of HOME_ROLES.entries()) {
      await expect(links.nth(index)).toHaveAttribute("href", expected[role.id]!);
    }
    await strip.getByRole("link", { name: "Owners" }).click();
    await expect(page).toHaveURL(/\/auth\/create-account\?mode=create&role=manager/);
  });

  test("the top bar: five section links, then Book a demo and Get started (to the portal chooser)", async ({ page }) => {
    await goHome(page);
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("link")).toHaveText(["How it works", "Software", "Service", "Pricing", "Contact"]);
    await expect(page.locator('[data-attr="home-nav-book-demo-desktop"]')).toHaveAttribute("href", BOOK_DEMO_HREF);
    const start = page.locator('[data-attr="home-nav-get-started"]');
    await expect(start).toHaveAttribute("href", GET_STARTED_HREF);
    await start.click();
    await expect(page).toHaveURL(/\/auth\/create-account$/);
    await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  });

  test("the sections read in order on a desktop", async ({ page }) => {
    await goHome(page);
    const headings = await page.evaluate(() =>
      [...document.querySelectorAll("h2")].filter((h) => h.getClientRects().length > 0).map((h) => h.textContent?.trim()),
    );
    expect(headings).toEqual(["How it works", "Software", "Service", "Pricing", "Contact", "Join free"]);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("Book a demo opens the Contact form in place with the request written in", async ({ page }) => {
    await goHome(page);
    await page.locator('[data-attr="home-nav-book-demo-desktop"]').click();
    await expect(page).toHaveURL(/topic=book-a-demo#contact$/);
    await expect(page.locator("#contact textarea")).toHaveValue(new RegExp(BOOK_DEMO_NOTE));
  });

  test("Join free: Resident, Vendor and Manager, each to its own sign-up", async ({ page }) => {
    await goHome(page);
    const rows = page.locator(".home-join-rows li");
    await expect(rows.locator(".home-join-role")).toHaveText(["Resident", "Vendor", "Manager"]);
    const hrefs = await rows.locator("a").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    expect(hrefs).toEqual([RESIDENT_GET_STARTED_HREF, VENDOR_GET_STARTED_HREF, MANAGER_GET_STARTED_HREF]);
  });

  test.describe("the Software demo", () => {
    test("loads the real portals in a frame that never writes: Resident, Property, Vendor, the role's phone", async ({ page }) => {
      const writes: string[] = [];
      const watch = (request: Request) => {
        const url = new URL(request.url());
        if (request.frame().url().includes("/demo/home-embed") && (request.method() !== "GET" || url.pathname.startsWith("/api/"))) {
          writes.push(`${request.method()} ${url.pathname}`);
        }
      };
      page.on("request", watch);
      await goHome(page);
      await page.locator("#dashboard").scrollIntoViewIfNeeded();
      const switcher = page.getByRole("tablist", { name: "Portal" });
      await expect(switcher.getByRole("tab")).toHaveText(["Resident", "Property", "Vendor"]);
      await expect(page.locator(".home-software-demo-phone-label")).toHaveText(/’s phone$/);
      await expect(page.locator(".home-software-demo-phone-label")).not.toHaveText(/Jordan/);
      const frame = page.frameLocator('iframe[title="PropLane portal demo"]');
      await expect(frame.locator("[data-home-demo-portal]")).toBeAttached({ timeout: 60_000 });
      // The visitor's pick opens that portal, full.
      await switcher.getByRole("tab", { name: "Vendor" }).click();
      await expect(switcher.getByRole("tab", { name: "Vendor" })).toHaveAttribute("aria-selected", "true");
      await expect(frame.locator('[data-home-demo-portal="vendor"]')).toBeAttached({ timeout: 30_000 });
      await page.waitForTimeout(1500);
      expect(writes).toEqual([]);
    });

    test("reduced motion never plays: the frame opens on the journey's end", async ({ browser }) => {
      const context = await browser.newContext({ reducedMotion: "reduce" });
      const page = await context.newPage();
      await goHome(page);
      await page.locator("#dashboard").scrollIntoViewIfNeeded();
      await expect(page.locator("#software-demo")).toHaveAttribute("data-reduced-motion", "true");
      await expect(page.locator('iframe[title="PropLane portal demo"]')).toHaveAttribute("src", /static=1/);
      await expect(page.frameLocator('iframe[title="PropLane portal demo"]').locator(".rlp-cursor")).toHaveCount(0);
      await context.close();
    });
  });

  test("a tablet swaps the demo for the three portal cards and nothing overflows", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 768, height: 1024 } });
    const page = await context.newPage();
    await goHome(page);
    await expect(page.locator(".home-software-card")).toHaveCount(3);
    expect(await shown(page, "#software-demo")).toBe(false);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await context.close();
  });

  test("a phone draws only the cover, Contact, Join free and the footer, with no Menu and no sideways scroll", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("#home-title").first()).toBeVisible();
    for (const gone of ["#how-stage", "#software-demo", "#service", "#pricing"]) expect(await shown(page, gone), gone).toBe(false);
    for (const kept of ["#home-hero", "#contact", ".home-join", "footer"]) expect(await shown(page, kept), kept).toBe(true);
    await expect(page.locator('[data-attr="home-nav-book-demo-mobile"]')).toBeVisible();
    await expect(page.locator('[data-attr="home-nav-get-started-phone"]')).toHaveAttribute("href", GET_STARTED_HREF);
    await expect(page.locator('[data-attr="home-nav-menu"]')).toBeHidden();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await context.close();
  });
});
