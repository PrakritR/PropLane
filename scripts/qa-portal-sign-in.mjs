/**
 * Shared Playwright portal sign-in for QA scripts.
 * Handles /auth/continue, manager Google onboarding, and choose-portal.
 */

/**
 * @param {import('playwright').Page} page
 * @param {{ email: string; password: string; role: string; home: string }} account
 * @param {string} baseUrl
 */
export async function signInToPortal(page, account, baseUrl) {
  const { email, password, role, home } = account;
  const homePath = home.split("?")[0];
  const port = new URL(baseUrl).port || "80";

  await page.goto(`${baseUrl}/auth/sign-in?next=${encodeURIComponent(home)}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  if (page.url().includes("/auth/sign-in")) {
    await page.getByPlaceholder("Email").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByPlaceholder("Email").fill(email);
    await page.getByPlaceholder("Password").fill(password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForFunction(() => !location.pathname.includes("/auth/sign-in"), {
      timeout: 60_000,
    }).catch(() => {});
  }

  const landed = new URL(page.url());
  if (landed.port && landed.port !== port && landed.hostname === "localhost") {
    await page.goto(`${baseUrl}${home}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  await completePostAuthNavigation(page, baseUrl);

  const portalPrefix = `/${homePath.split("/").filter(Boolean)[0]}`;
  if (!new URL(page.url()).pathname.startsWith(portalPrefix)) {
    const labels = { manager: "Property", resident: "Resident", vendor: "Vendor", admin: "Admin" };
    const label = labels[role];
    if (label) {
      await page.goto(`${baseUrl}/auth/choose-portal?next=${encodeURIComponent(home)}`, {
        waitUntil: "domcontentloaded",
      });
      const btn = page.getByRole("button", { name: new RegExp(`^${label}\\b`) });
      if (await btn.count()) {
        await btn.first().click();
        await page.waitForTimeout(2000);
      }
    }
  }
}

/**
 * Next.js dev overlay blocks Playwright clicks on localhost — remove it in QA only.
 * @param {import('playwright').Page} page
 */
export async function dismissDevOverlay(page) {
  await page
    .evaluate(() => {
      for (const el of document.querySelectorAll("nextjs-portal, [data-nextjs-dev-overlay]")) {
        el.remove();
      }
    })
    .catch(() => {});
}

/**
 * @param {import('playwright').Page} page
 * @param {string} baseUrl
 */
export async function completePostAuthNavigation(page, baseUrl) {
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    const path = new URL(page.url()).pathname;

    if (path.includes("/auth/connect-google-services")) {
      const cont = page.getByRole("button", { name: /^continue$/i });
      if (await cont.count()) {
        await cont.first().click();
        await page.waitForFunction(
          () => !location.pathname.includes("/auth/connect-google-services"),
          { timeout: 30_000 },
        ).catch(() => {});
        continue;
      }
      await page.waitForTimeout(750);
      continue;
    }

    if (path === "/auth/continue") {
      await page.waitForTimeout(750);
      continue;
    }

    if (!path.startsWith("/auth/")) return;
    await page.waitForTimeout(750);
  }
}
