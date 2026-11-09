import { expect, type Frame, type Page } from "@playwright/test";
import { readFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

type OnSignupPhase = (phase: string, httpStatus?: number) => void;

function safePathname(rawUrl: string): string {
  return new URL(rawUrl).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id");
}

function authProofSpool(email: string): string {
  const captureDir = process.env.AUTH_PROOF_CAPTURE_DIR;
  if (!captureDir || !path.isAbsolute(captureDir)) throw new Error("Email onboarding requires the private no-delivery capture directory.");
  return path.join(captureDir, `${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}.json`);
}

/** Read one exact-recipient auth-confirm capture, never returning it to logs. */
export async function readCapturedAuthProof(page: Page, email: string): Promise<string> {
  const normalizedEmail = email.trim().toLowerCase();
  const spool = authProofSpool(normalizedEmail);
  await expect.poll(() => existsSync(spool), { timeout: 15_000 }).toBe(true);
  const captured = JSON.parse(readFileSync(spool, "utf8")) as { recipient?: string; href?: string };
  if (captured.recipient !== normalizedEmail || !captured.href) throw new Error("The private auth-proof capture did not match the exact synthetic recipient.");
  const href = new URL(captured.href);
  const port = Number(href.port);
  if (href.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(href.hostname) || !Number.isInteger(port) || port < 3000 || port > 3014 || href.pathname !== "/auth/confirm" || !href.searchParams.get("token_hash")) {
    throw new Error("The captured auth proof is not an allowed local token-hash link.");
  }
  return href.toString();
}

/** Read only this run's exact-recipient archived Resend payloads (transport remains simulated). */
export function readCapturedOutboundMail(email: string): Array<{ transport: string; recipient: string; payload: Record<string, unknown> }> {
  const normalizedEmail = email.trim().toLowerCase();
  const captureDir = process.env.AUTH_PROOF_CAPTURE_DIR;
  if (!captureDir || !path.isAbsolute(captureDir)) throw new Error("Email onboarding requires the private no-delivery capture directory.");
  const prefix = createHash("sha256").update(normalizedEmail).digest("hex").slice(0, 12);
  return readdirSync(captureDir)
    .filter((name) => /^\d{2}-[a-f0-9]{12}\.json$/.test(name) && name.endsWith(`-${prefix}.json`))
    .map((name) => JSON.parse(readFileSync(path.join(captureDir, name), "utf8")) as { transport: string; recipient: string; payload: Record<string, unknown> })
    .filter((message) => message.recipient?.trim().toLowerCase() === normalizedEmail && message.transport === "simulated-not-delivered");
}

/** Bounded wait for an archived exact-recipient message after its acknowledged send request. */
export async function waitForCapturedOutboundMail(page: Page, email: string): Promise<Array<{ transport: string; recipient: string; payload: Record<string, unknown> }>> {
  await expect.poll(() => readCapturedOutboundMail(email).length, { timeout: 15_000 }).toBeGreaterThan(0);
  return readCapturedOutboundMail(email);
}

async function boundedDomBoolean(read: Promise<boolean>, timeoutMs = 3_000): Promise<boolean | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    read.catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/** Requires the dedicated no-delivery server preload; never sends real mail. */
export async function requestManagerEmailProof(page: Page, email: string, onPhase?: OnSignupPhase, expectedTier?: "free" | "pro" | "business"): Promise<string> {
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
  if (!startResult.ok()) throw new Error("Email-onboarding start rejected the synthetic request.");
  if (expectedTier) {
    const body = startResult.request().postDataJSON() as { intent?: unknown; tier?: unknown; billing?: unknown } | null;
    if (body?.intent !== "manager" || body.tier !== expectedTier || body.billing !== "monthly") {
      throw new Error("Manager email-onboarding start did not preserve the requested test tier.");
    }
  }
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

export async function finishManagerEmailProof(page: Page, href: string, email: string, fullName: string, phone: string, onPhase?: OnSignupPhase, expectedTier?: "free" | "pro" | "business"): Promise<{ managerRegisterStatus: number }> {
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
      verifiedFormVisible: Array.from(document.querySelectorAll("input[readonly]")).some((input) =>
        input instanceof HTMLInputElement && input.labels?.[0]?.textContent?.trim() === "Verified email",
      ),
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
    const result = await boundedDomBoolean(page.getByLabel("Verified email", { exact: true }).isVisible());
    verifiedFormVisible = result === true;
    if (!verifiedFormVisible) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!verifiedFormVisible) throw new Error("Verified-email form did not appear within the bounded wait.");
  const verifiedEmailInput = page.getByLabel("Verified email", { exact: true });
  const exactMailboxMatch = await boundedDomBoolean(verifiedEmailInput.inputValue().then((value) => value === email));
  if (exactMailboxMatch !== true) throw new Error("Verified email did not match the synthetic mailbox.");
  if (await verifiedEmailInput.isEditable()) throw new Error("Verified email must remain read-only after token verification.");
  onPhase?.("fill-manager-name");
  await page.getByLabel("Full name").fill(fullName);
  onPhase?.("fill-manager-phone");
  if (!/^\+1\d{10}$/.test(phone)) throw new Error("Manager signup proof requires a normalized test E.164 phone.");
  await page.getByRole("textbox", { name: /phone/i }).fill(phone.slice(2));
  onPhase?.("finish-api");
  const finishResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/auth/manager-register";
  }, { timeout: 20_000 });
  await page.getByRole("button", { name: "Complete account" }).click();
  const finishResult = await finishResponse;
  onPhase?.("finish-api-response", finishResult.status());
  if (!finishResult.ok()) throw new Error("Manager registration endpoint rejected the synthetic account.");
  const finishBody = finishResult.request().postDataJSON() as { email?: unknown; fullName?: unknown; phone?: unknown; tier?: unknown } | null;
  if (finishBody?.email !== email || finishBody.fullName !== fullName || finishBody.phone !== phone || (expectedTier && finishBody.tier !== expectedTier)) {
    throw new Error("Manager-register request did not match the exact synthetic signup payload.");
  }
  onPhase?.("await-account-ready");
  await expect(page.getByRole("heading", { name: "Account ready" })).toBeVisible({ timeout: 20_000 });
  const dir = process.env.AUTH_PROOF_CAPTURE_DIR;
  if (dir && path.isAbsolute(dir)) unlinkSync(path.join(dir, `${createHash("sha256").update(email.toLowerCase()).digest("hex")}.json`));
  return { managerRegisterStatus: finishResult.status() };
}

export async function completeManagerEmailProof(page: Page, email: string, fullName: string, phone: string): Promise<void> {
  const href = await requestManagerEmailProof(page, email);
  await finishManagerEmailProof(page, href, email, fullName, phone);
}

/** Request a real resident mailbox proof for an exact synthetic listing. */
export async function requestResidentEmailProof(page: Page, email: string, propertyId: string): Promise<string> {
  const captureDir = process.env.AUTH_PROOF_CAPTURE_DIR;
  if (!captureDir || !path.isAbsolute(captureDir)) throw new Error("Resident signup E2E requires the isolated no-delivery Resend capture directory.");
  const normalizedEmail = email.trim().toLowerCase();
  const spool = path.join(captureDir, `${createHash("sha256").update(normalizedEmail).digest("hex")}.json`);
  await page.getByLabel("Email", { exact: true }).fill(normalizedEmail);
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/auth/email-onboarding/start";
  }, { timeout: 20_000 });
  await page.getByRole("button", { name: "Continue with email" }).click();
  const response = await responsePromise;
  if (!response.ok()) throw new Error("Resident email-onboarding start rejected the synthetic request.");
  const body = response.request().postDataJSON() as { email?: unknown; intent?: unknown; propertyId?: unknown } | null;
  if (body?.email !== normalizedEmail || body.intent !== "resident" || body.propertyId !== propertyId) {
    throw new Error("Resident email-onboarding start did not retain the exact mailbox and listing.");
  }
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  return readCapturedAuthProof(page, normalizedEmail);
}

/** Finish the email-first resident flow with its actual token_hash and register route. */
export async function finishResidentEmailProof(page: Page, href: string, email: string, fullName: string, phone: string): Promise<number> {
  const normalizedEmail = email.trim().toLowerCase();
  await page.goto(href, { waitUntil: "domcontentloaded", timeout: 20_000 });
  const verifiedEmail = page.getByLabel("Verified email", { exact: true });
  await expect(verifiedEmail).toHaveValue(normalizedEmail, { timeout: 20_000 });
  await expect(verifiedEmail).toHaveAttribute("readonly", "");
  await page.getByLabel("Full name", { exact: true }).fill(fullName);
  if (!/^\+1\d{10}$/.test(phone)) throw new Error("Resident signup requires a normalized synthetic E.164 phone.");
  await page.getByRole("textbox", { name: /phone/i }).fill(phone.slice(2));
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/auth/resident-register";
  }, { timeout: 20_000 });
  await page.getByRole("button", { name: "Complete account" }).click();
  const response = await responsePromise;
  if (!response.ok()) throw new Error("Resident registration rejected the verified synthetic account.");
  const body = response.request().postDataJSON() as { email?: unknown; fullName?: unknown; phone?: unknown } | null;
  if (body?.email !== normalizedEmail || body.fullName !== fullName || body.phone !== phone) {
    throw new Error("Resident registration request did not match the verified synthetic account.");
  }
  const dir = process.env.AUTH_PROOF_CAPTURE_DIR;
  if (dir && path.isAbsolute(dir)) unlinkSync(authProofSpool(normalizedEmail));
  await page.waitForURL((url) => url.pathname.startsWith("/resident") || url.pathname === "/auth/verify-phone", { timeout: 45_000 });
  const destination = new URL(page.url());
  if (destination.pathname === "/auth/verify-phone") {
    const next = destination.searchParams.get("next");
    if (!next || !next.startsWith("/resident")) throw new Error("Resident registration reached an unexpected phone-gate destination.");
  } else if (!destination.pathname.startsWith("/resident")) {
    throw new Error("Resident registration did not reach its resident portal or exact phone gate.");
  }
  await expect(page.getByRole("alert").filter({ hasText: /could not create resident account/i })).toHaveCount(0);
  return response.status();
}
