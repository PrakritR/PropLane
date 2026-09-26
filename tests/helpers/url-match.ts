import type { Page } from "@playwright/test";

/** Escape all regex metacharacters — a partial escape (e.g. only "/") can leave
 * other characters (".", "\\", etc.) able to alter the match. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a RegExp for `expect(page).toHaveURL` — matches the path inside a full URL and allows default sub-segments. */
export function pathToUrlRegExp(path: string): RegExp {
  return new RegExp(`${escapeRegExp(path)}(?:/|$|\\?)`);
}

function pathPrefixMatches(actualUrl: string, targetUrl: URL): boolean {
  const actual = new URL(actualUrl);
  const path = targetUrl.pathname;
  const prefix = path.endsWith("/") ? path : `${path}/`;
  if (actual.pathname !== path && !actual.pathname.startsWith(prefix)) return false;
  for (const [key, value] of targetUrl.searchParams) {
    if (actual.searchParams.get(key) !== value) return false;
  }
  return true;
}

/**
 * Navigate to an in-app path. Next.js dev / RSC navigations sometimes abort the
 * initial document load (`net::ERR_ABORTED`) when a client redirect wins the
 * race — retry until the pathname matches the target (including default
 * sub-segments such as `/portal/properties/listed` or `/resident/tour/pending`).
 */
export async function gotoAppPath(page: Page, path: string, timeout = 45_000) {
  const targetUrl = new URL(path, "http://localhost");
  const deadline = Date.now() + timeout;
  let lastUrl = page.url();
  while (Date.now() < deadline) {
    lastUrl = page.url();
    const pathname = new URL(lastUrl).pathname;
    if (pathname === "/auth/sign-in") {
      throw new Error(`Session expired while navigating to ${path}`);
    }
    if (pathPrefixMatches(lastUrl, targetUrl)) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      await page.goto(path, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(15_000, remaining),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ERR_ABORTED")) throw error;
    }
    if (pathPrefixMatches(page.url(), targetUrl)) return;
    await page.waitForTimeout(300);
  }
  throw new Error(`Timed out navigating to ${path} (last url: ${lastUrl})`);
}
