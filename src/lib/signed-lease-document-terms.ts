import { parseMoneyAmount } from "@/lib/parse-money";
import type { UploadedLeaseParse } from "@/lib/uploaded-lease-extraction";
import { resolvedFieldValue } from "@/lib/uploaded-lease-extraction";
import type { ExecutedLeaseTermsSource } from "@/lib/lease-signed-terms";

export type SignedLeaseTerms = {
  monthlyRent?: number;
  monthlyUtilities?: number;
  securityDeposit?: number;
  moveInFee?: number;
};

const SUMMARY_ROW = (label: string) =>
  new RegExp(
    String.raw`<t[hd][^>]*>\s*${label}\s*</t[hd]>\s*<td[^>]*>([\s\S]*?)</td>`,
    "i",
  );

const COMPACT_PARAGRAPH = (label: string) =>
  new RegExp(
    String.raw`<p\b[^>]*>\s*<strong\b[^>]*>\s*${label}\s*:\s*</strong>([\s\S]*?)</p>`,
    "i",
  );

function moneyFromHtml(html: string, label: string, compactLabel = label): number | undefined {
  const value = SUMMARY_ROW(label).exec(html)?.[1] ?? COMPACT_PARAGRAPH(compactLabel).exec(html)?.[1];
  if (value == null) return undefined;
  const plain = value.trim().replace(/^<strong\b[^>]*>([\s\S]*)<\/strong>$/i, "$1").trim();
  if (!/^\$\s*(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{2})?$/.test(plain)) return undefined;
  const amount = parseMoneyAmount(plain);
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

/**
 * The money terms as the generated lease document states them. The summary
 * table `build-lease-html.ts` renders is the contract: `<th>Monthly rent</th>`
 * followed by the amount cell. A document that says "Daily rent" states no
 * monthly figure and returns none for rent.
 */
export function signedTermsFromLeaseHtml(html: string | null | undefined): SignedLeaseTerms {
  if (!html) return {};
  const out: SignedLeaseTerms = {};
  const rent = moneyFromHtml(html, "Monthly rent");
  if (rent !== undefined && rent > 0) out.monthlyRent = rent;
  const utilities = moneyFromHtml(html, "Monthly utilities", "Utilit(?:y|ies)");
  if (utilities !== undefined) out.monthlyUtilities = utilities;
  const deposit = moneyFromHtml(html, "Security deposit");
  if (deposit !== undefined) out.securityDeposit = deposit;
  const moveIn = moneyFromHtml(html, "Move-in fee");
  if (moveIn !== undefined) out.moveInFee = moveIn;
  return out;
}

/** The money terms an uploaded PDF's structured parse extracted (manager overrides win). */
export function signedTermsFromUploadedParse(parse: UploadedLeaseParse | null | undefined): SignedLeaseTerms {
  if (!parse || parse.status !== "parsed") return {};
  const out: SignedLeaseTerms = {};
  for (const field of parse.fields) {
    if (field.key !== "monthlyRent" && field.key !== "securityDeposit") continue;
    const { value } = resolvedFieldValue(field, parse.review);
    if (!value.trim()) continue;
    const amount = parseMoneyAmount(value);
    if (!Number.isFinite(amount) || amount < 0) continue;
    if (field.key === "monthlyRent" && amount > 0) out.monthlyRent = amount;
    if (field.key === "securityDeposit") out.securityDeposit = amount;
  }
  return out;
}

/** The terms the executed document states, generated HTML first, then the upload parse. */
export function signedTermsFromExecutedLease(lease: ExecutedLeaseTermsSource | null | undefined): SignedLeaseTerms {
  if (!lease) return {};
  const html =
    lease.generatedHtml ||
    lease.signedLeaseSnapshots?.find((s) => s.generatedHtml)?.generatedHtml ||
    null;
  const fromHtml = signedTermsFromLeaseHtml(html);
  const fromParse = signedTermsFromUploadedParse(lease.uploadedLeaseParse);
  return { ...fromParse, ...fromHtml };
}

