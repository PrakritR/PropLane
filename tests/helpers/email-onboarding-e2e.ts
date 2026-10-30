import { expect, type Page } from "@playwright/test";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/** Requires the dedicated no-delivery server preload; never sends real mail. */
export async function requestManagerEmailProof(page: Page, email: string): Promise<string> {
  const captureDir = process.env.AUTH_PROOF_CAPTURE_DIR;
  if (!captureDir || !path.isAbsolute(captureDir)) throw new Error("Manager signup E2E requires the isolated no-delivery Resend preload and AUTH_PROOF_CAPTURE_DIR.");
  const spool = path.join(captureDir, `${createHash("sha256").update(email.toLowerCase()).digest("hex")}.json`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Continue with email" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect.poll(() => existsSync(spool), { timeout: 15_000 }).toBe(true);
  const captured = JSON.parse(readFileSync(spool, "utf8")) as { recipient?: string; href?: string };
  if (captured.recipient !== email || !captured.href) throw new Error("The isolated verification capture did not match the synthetic recipient.");
  const href = new URL(captured.href);
  if (!["localhost", "127.0.0.1"].includes(href.hostname) || href.pathname !== "/auth/confirm" || !href.searchParams.get("token_hash")) throw new Error("The verification capture is not a local token-hash link.");
  return href.toString();
}

export async function finishManagerEmailProof(page: Page, href: string, email: string, fullName: string, phone: string): Promise<void> {
  await page.goto(href.toString());
  await expect(page.getByText(`Verified email: ${email}`)).toBeVisible({ timeout: 60_000 });
  await page.getByLabel("Full name").fill(fullName);
  await page.getByRole("textbox", { name: /phone/i }).fill(phone);
  await page.getByRole("button", { name: "Complete account" }).click();
  await expect(page.getByRole("heading", { name: "Account ready" })).toBeVisible({ timeout: 60_000 });
  const dir = process.env.AUTH_PROOF_CAPTURE_DIR;
  if (dir && path.isAbsolute(dir)) unlinkSync(path.join(dir, `${createHash("sha256").update(email.toLowerCase()).digest("hex")}.json`));
}

export async function completeManagerEmailProof(page: Page, email: string, fullName: string, phone: string): Promise<void> {
  const href = await requestManagerEmailProof(page, email);
  await finishManagerEmailProof(page, href, email, fullName, phone);
}
