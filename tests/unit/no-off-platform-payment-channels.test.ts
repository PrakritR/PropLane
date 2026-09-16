import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * PLAN-0916 removed off-platform payment channels outright: residents and
 * applicants pay through PropLane (Stripe bank / card), vendors are paid by ACH
 * through Stripe Connect, and no inbox is read for receipts. This scan keeps
 * the product that way — the retired channels, the receipt-matching modules and
 * the routes that served them must not creep back into runtime code.
 *
 * The names below are allowed only where a stored row is being CLEANED
 * (`RETIRED_LISTING_PAYMENT_KEYS` in the listing normalizer): a legacy record
 * may still carry them, and dropping them on read is exactly the point.
 */
function walk(dir: string, exts: string[]): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path, exts);
    return exts.some((ext) => path.endsWith(ext)) ? [path] : [];
  });
}

const ALLOWED_FILES = new Set(["src/lib/manager-listing-submission.ts"]);

const RETIRED = /zelle|venmo|gmail-payments|gmail_payments|paymentInboxToken|receiptAutoMark|paidViaGmail/i;

describe("PLAN-0916: no off-platform payment channels in runtime code", () => {
  it("no src/ file mentions Zelle, Venmo or Gmail receipt tracking", () => {
    const offenders: string[] = [];
    for (const file of walk("src", [".ts", ".tsx", ".mjs"])) {
      const rel = file.replace(/\\/g, "/");
      if (ALLOWED_FILES.has(rel)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        // `gmail.com` is an email domain, not the retired integration.
        if (RETIRED.test(line.replace(/gmail\.com/gi, ""))) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the retired modules and routes are gone", () => {
    for (const path of [
      "src/lib/gmail-payments",
      "src/lib/payment-receipt-email",
      "src/lib/payment-reference.ts",
      "src/lib/resident-manual-payment.server.ts",
      "src/lib/resident-check-manual-payment.server.ts",
      "src/lib/resident-report-manual-payment.server.ts",
      "src/app/api/portal/gmail-payments",
      "src/app/api/vendor/gmail-payments",
      "src/app/api/cron/sync-manual-payments",
      "src/app/api/portal/resident-report-manual-payment",
      "src/app/api/portal/resident-check-manual-payment",
      "src/app/api/public/application-fee-check-payment",
      "src/components/portal/gmail-payment-auto-track-panel.tsx",
      "src/components/portal/resident-manual-payment-panel.tsx",
    ]) {
      expect(existsSync(path), `${path} should not exist`).toBe(false);
    }
  });

  it("the receipt-sync cron is not scheduled", () => {
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons?: { path: string }[] };
    expect((vercel.crons ?? []).map((c) => c.path)).not.toContain("/api/cron/sync-manual-payments");
  });
});
