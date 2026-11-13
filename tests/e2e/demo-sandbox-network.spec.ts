import { test, expect, type Request, type Response } from "@playwright/test";

/**
 * The home Software demo is the only public /demo exception. Its iframe uses
 * synthetic local data and intercepts API calls in the browser; it must not
 * reach real portal APIs or send writes over the network. See demo-sandbox.md.
 */
test.describe("public demo isolation", () => {
  test("/demo redirects home", async ({ page }) => {
    await page.goto("/demo");
    await expect(page).toHaveURL(/\/$/);
  });

  test("/demo/role/manager redirects home", async ({ page }) => {
    await page.goto("/demo/role/manager");
    await expect(page).toHaveURL(/\/$/);
  });

  test("the home iframe keeps the three seeded portal views off real APIs", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const forbidden: string[] = [];
    const errors: string[] = [];
    page.on("request", (request: Request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/demo") && url.pathname !== "/demo/home-embed") {
        forbidden.push(`${request.method()} ${url.pathname}`);
      }
      if (request.frame() !== page.mainFrame() && (url.pathname.startsWith("/api/") || request.method() !== "GET")) {
        forbidden.push(`${request.method()} ${url.pathname}`);
      }
    });
    page.on("response", (response: Response) => {
      if (response.request().frame() !== page.mainFrame() && [401, 403].includes(response.status())) {
        errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
      }
    });
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/");
    await page.locator("#dashboard").scrollIntoViewIfNeeded();
    const iframe = page.locator('#dashboard iframe[title="PropLane portal demo"]');
    await expect(iframe).toHaveCount(1);
    await expect(iframe).toHaveAttribute("src", /^\/demo\/home-embed(?:\?.*)?$/);
    const frame = page.frameLocator('#dashboard iframe[title="PropLane portal demo"]');
    await expect(frame.locator("[data-home-demo-portal]")).toBeAttached({ timeout: 60_000 });
    const tabs = page.getByRole("tablist", { name: "Portal" });
    // Each role lands on its service view of Jordan’s seeded faucet request.
    for (const [label, role, fixture] of [
      ["Resident", "resident", "Leaking kitchen faucet"],
      ["Property", "manager", "Leaking kitchen faucet"],
      ["Vendor", "vendor", "Leaking kitchen faucet"],
    ] as const) {
      await tabs.getByRole("tab", { name: label }).click();
      await expect(tabs.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
      await expect(frame.locator(`[data-home-demo-portal="${role}"]`)).toBeAttached({ timeout: 30_000 });
      const panel = frame.locator("#portal-main-content");
      await expect(panel).toBeVisible();
      await expect(panel.getByText(fixture, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    }
    // Watch briefly after the last panel settles for delayed requests and effects.
    await page.waitForTimeout(1_000);
    expect(forbidden).toEqual([]);
    expect(errors).toEqual([]);
  });
});
