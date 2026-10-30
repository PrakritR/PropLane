import { expect, type Frame, type Page } from "@playwright/test";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

type OnSignupPhase = (phase: string, httpStatus?: number) => void;

function safePathname(rawUrl: string): string {
  return new URL(rawUrl).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id");
}

async function boundedDomBoolean(read: Promise<boolean>, timeoutMs = 3_000): Promise<boolean | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    read.catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/** Requires the dedicated no-delivery server preload; never sends real mail. */
export async function requestManagerEmailProof(page: Page, email: string, onPhase?: OnSignupPhase): Promise<string> {
  const captureDir = process.env.AUTH_PROOF_CAPTURE_DIR;
  if (!captureDir || !path.isAbsolute(captureDir)) throw new Error("Manager signup E2E requires the isolated no-delivery Resend preload and AUTH_PROOF_CAPTURE_DIR.");
  const spool = path.join(captureDir, `${createHash("sha256").update(email.toLowerCase()).digest("hex")}.json`);
  onPhase?.("request-email-and-capture");
  await page.getByLabel("Email", { exact: true }).fill(email);
  const startResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/auth/email-onboarding/start";
  }, { timeout: 20_000 });
  await page.getByRole("button", { name: "Continue with email" }).click();
  const startResult = await startResponse;
  onPhase?.("email-onboarding-start-response", startResult.status());
  onPhase?.("await-email-capture");
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect.poll(() => existsSync(spool), { timeout: 15_000 }).toBe(true);
  onPhase?.("read-email-capture");
  const captured = JSON.parse(readFileSync(spool, "utf8")) as { recipient?: string; href?: string };
  if (captured.recipient !== email || !captured.href) throw new Error("The isolated verification capture did not match the synthetic recipient.");
  const href = new URL(captured.href);
  if (!["localhost", "127.0.0.1"].includes(href.hostname) || href.pathname !== "/auth/confirm" || !href.searchParams.get("token_hash")) throw new Error("The verification capture is not a local token-hash link.");
  return href.toString();
}

export async function finishManagerEmailProof(page: Page, href: string, email: string, fullName: string, phone: string, onPhase?: OnSignupPhase): Promise<void> {
  const navigationStarted = Date.now();
  const navigations: string[] = [];
  const captureNavigation = (frame: Frame) => {
    if (frame !== page.mainFrame() || Date.now() - navigationStarted > 20_000 || navigations.length >= 20) return;
    const pathname = safePathname(frame.url());
    if (navigations[navigations.length - 1] !== pathname) navigations.push(pathname);
  };
  page.on("framenavigated", captureNavigation);
  onPhase?.("callback-navigation");
  const callbackResponse = await page.goto(href.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 });
  onPhase?.("callback-navigation-response", callbackResponse?.status());
  onPhase?.("poll-callback-pathname");
  const callbackDeadline = navigationStarted + 20_000;
  let callbackPathname = new URL(page.url()).pathname;
  while (callbackPathname === "/auth/confirm" && Date.now() < callbackDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    callbackPathname = new URL(page.url()).pathname;
  }
  callbackPathname = safePathname(page.url());
  console.log(`[synthetic-manager-e2e] callback_pathname=${callbackPathname}`);
  onPhase?.("sample-callback-dom");
  const callbackPageRead = page.evaluate(() => {
    const knownHeadings = new Set(["Create your property account", "Complete your property account", "Check your email", "Account ready", "Request a new verification link", "Could not complete verification", "Link invalid"]);
    const knownAlerts = new Set(["This link has expired", "This link is invalid", "Email verified", "Something went wrong", "Could not continue account setup. Refresh to try again."]);
    const bodyText = document.body.innerText;
    const text = (selector: string, allow: Set<string>) => Array.from(document.querySelectorAll(selector))
      .map((element) => (element.textContent ?? "").trim())
      .filter((value) => allow.has(value));
    return {
      pathname: location.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id"),
      headings: text("h1,h2", knownHeadings),
      alerts: text('[role="alert"]', knownAlerts),
      loadingVisible: /\bLoading(?:…|\.\.\.)?(?=\s|$)/i.test(bodyText),
      verifiedFormVisible: bodyText.includes("Verified email:"),
    };
  });
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  const callbackPage = await Promise.race([
    callbackPageRead.catch(() => null),
    new Promise<null>((resolve) => { snapshotTimer = setTimeout(() => resolve(null), 3_000); }),
  ]).finally(() => { if (snapshotTimer) clearTimeout(snapshotTimer); });
  const snapshot = callbackPage ?? {
    pathname: callbackPathname,
    headings: [],
    alerts: [],
    loadingVisible: false,
    verifiedFormVisible: false,
    domRead: "timeout-or-error",
  };
  page.off("framenavigated", captureNavigation);
  console.log(`[synthetic-manager-e2e] callback_page=${JSON.stringify({ ...snapshot, navigations })}`);
  onPhase?.("await-verified-email");
  const verifiedDeadline = Date.now() + 20_000;
  let verifiedFormVisible = false;
  while (!verifiedFormVisible && Date.now() < verifiedDeadline) {
    const result = await boundedDomBoolean(page.evaluate(() => Array.from(document.querySelectorAll("p")).some((element) => (element.textContent ?? "").trim().startsWith("Verified email:"))));
    verifiedFormVisible = result === true;
    if (!verifiedFormVisible) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!verifiedFormVisible) throw new Error("Verified-email form did not appear within the bounded wait.");
  const exactMailboxMatch = await boundedDomBoolean(page.evaluate((expectedEmail) => Array.from(document.querySelectorAll("p")).some((element) => (element.textContent ?? "").trim() === `Verified email: ${expectedEmail}`), email));
  if (exactMailboxMatch !== true) throw new Error("Verified email did not match the synthetic mailbox.");
  onPhase?.("fill-manager-name");
  await page.getByLabel("Full name").fill(fullName);
  onPhase?.("fill-manager-phone");
  await page.getByRole("textbox", { name: /phone/i }).fill(phone);
  onPhase?.("finish-api");
  const finishResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/auth/manager-register";
  }, { timeout: 20_000 });
  await page.getByRole("button", { name: "Complete account" }).click();
  const finishResult = await finishResponse;
  onPhase?.("finish-api-response", finishResult.status());
  onPhase?.("await-account-ready");
  await expect(page.getByRole("heading", { name: "Account ready" })).toBeVisible({ timeout: 20_000 });
  const dir = process.env.AUTH_PROOF_CAPTURE_DIR;
  if (dir && path.isAbsolute(dir)) unlinkSync(path.join(dir, `${createHash("sha256").update(email.toLowerCase()).digest("hex")}.json`));
}

export async function completeManagerEmailProof(page: Page, email: string, fullName: string, phone: string): Promise<void> {
  const href = await requestManagerEmailProof(page, email);
  await finishManagerEmailProof(page, href, email, fullName, phone);
}
