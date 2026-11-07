import { test, expect, type Page } from "@playwright/test";

/**
 * docs/agents/marketing-mocks.md, One Software section (Oct 18-19): the
 * retired hero/lifecycle/import panels are replaced by one real-portal embed.
 * Only /demo/home-embed is public; its data and writes remain browser-local.
 */
function isBannedRequest(url: string, method: string): boolean {
  const pathname = new URL(url).pathname;
  if (pathname.startsWith("/demo")) return pathname !== "/demo/home-embed";
  if (!pathname.startsWith("/api/")) return false;
  return method !== "GET" || pathname !== "/api/agent/demo-chat";
}

async function openSoftware(page: Page) {
  await page.goto("/");
  await page.locator("#dashboard").scrollIntoViewIfNeeded();
  const frame = page.frameLocator('iframe[title="PropLane portal demo"]');
  await expect(frame.locator("[data-home-demo-portal]")).toBeVisible();
  await expect(frame.getByRole("status").filter({ hasText: "Loading the demo…" })).toHaveCount(0);
  return frame;
}

test.describe("public software demo isolation", () => {
  test("/demo redirects home", async ({ page }) => {
    await page.goto("/demo");
    await expect(page).toHaveURL(/\/$/);
  });

  test("/demo/anything redirects home", async ({ page }) => {
    await page.goto("/demo/role/manager");
    await expect(page).toHaveURL(/\/$/);
  });

  test("home and the populated portal embed make no private API requests or writes", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const banned: string[] = [];
    const failures: number[] = [];
    const errors: string[] = [];
    page.on("request", (request) => {
      if (isBannedRequest(request.url(), request.method())) banned.push(new URL(request.url()).pathname);
    });
    page.on("response", (response) => {
      if (response.request().frame().parentFrame() && [401, 403].includes(response.status())) failures.push(response.status());
    });
    page.on("pageerror", (error) => errors.push(error.name));
    const frame = await openSoftware(page);
    for (const name of ["Resident", "Property", "Vendor"] as const) {
      await page.locator("#software-demo").getByRole("tab", { name, exact: true }).click();
      await expect(frame.locator("[data-home-demo-portal]")).toHaveAttribute("data-home-demo-portal", name === "Property" ? "manager" : name.toLowerCase());
      await expect(frame.getByText(/Willow Court|Leaking kitchen faucet/).first()).toBeVisible();
    }
    for (const id of ["how", "service", "pricing", "contact"]) {
      await page.locator(`#${id}`).first().scrollIntoViewIfNeeded();
    }
    expect(banned).toEqual([]);
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("reduced motion renders the populated journey end frame without autoplay", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const frame = await openSoftware(page);
    await expect(page.locator("#software-demo")).toHaveAttribute("data-playing", "false");
    await expect(frame.locator("[data-home-demo-static]")).toHaveAttribute("data-home-demo-static", "true");
    await expect(frame.locator("[data-home-demo-portal]")).toHaveAttribute("data-home-demo-portal", "manager");
    await expect(frame.getByText("Leaking kitchen faucet").first()).toBeVisible();
    await expect(page.locator(".home-software-demo-phone-label")).toHaveText("Vendor’s phone");
    await expect(page.locator(".home-software-demo-phone").getByText("It’s yours. We’ll send you the details.", { exact: true })).toBeVisible();
    await expect(page.locator('iframe[title="PropLane portal demo"]')).toHaveCount(1);
  });

  test("portal switcher keeps the real portal and phone in the same journey", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const frame = await openSoftware(page);
    const section = page.locator("#software-demo");
    for (const [label, role, phone] of [
      ["Resident", "resident", "Resident’s phone"],
      ["Vendor", "vendor", "Vendor’s phone"],
      ["Property", "manager", "Vendor’s phone"],
    ] as const) {
      const tab = section.getByRole("tab", { name: label, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(frame.locator("[data-home-demo-portal]")).toHaveAttribute("data-home-demo-portal", role);
      await expect(frame.getByText(/Willow Court|Leaking kitchen faucet/).first()).toBeVisible();
      await expect(section.locator(".home-software-demo-phone-label")).toHaveText(phone);
    }
  });

  test("phone viewport keeps Software hidden without loading a demo or private request", async ({ page }) => {
    const demoRequests: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith("/demo") || isBannedRequest(request.url(), request.method())) demoRequests.push(pathname);
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.locator("#dashboard")).toBeHidden();
    await expect(page.locator('iframe[title="PropLane portal demo"]')).toHaveCount(0);
    expect(demoRequests).toEqual([]);
  });

  test("tablet viewport renders the three current software portal cards without an embed", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto("/");
    await page.locator("#dashboard").scrollIntoViewIfNeeded();
    for (const label of ["Resident", "Property", "Vendor"]) {
      await expect(page.locator(".home-software-compact").getByRole("heading", { name: label, exact: true })).toBeVisible();
    }
    await expect(page.locator(".home-software-card")).toHaveCount(3);
    await expect(page.locator('iframe[title="PropLane portal demo"]')).toHaveCount(0);
  });
});
