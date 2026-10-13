/**
 * Bank names arrive from the processor in whatever case the bank registered ("STRIPE TEST BANK").
 * A label that is ALL CAPS is shown title-cased ("Stripe Test Bank"); a name already in mixed case
 * is the bank's own spelling and is left alone. Presentation only: the account id and last four never change.
 */
const KEEP_UPPER = new Set(["US", "USA", "USAA", "TD", "PNC", "HSBC", "BMO", "BBVA", "UBS", "RBC", "SVB", "FNB", "BNY", "TIAA", "UW", "ATM", "CU", "FCU", "LLC", "NA", "N.A.", "ACH"]);
const KEEP_LOWER = new Set(["of", "and", "the", "for", "at", "in", "on", "to"]);

export function titleCaseBankName(label: string | null | undefined): string {
  const text = (label ?? "").trim();
  if (!text) return "";
  if (text !== text.toUpperCase()) return text;
  return text
    .split(/\s+/)
    .map((word, index) => {
      if (KEEP_UPPER.has(word)) return word;
      const lower = word.toLowerCase();
      if (index > 0 && KEEP_LOWER.has(lower)) return lower;
      return lower.replace(/(^|[-'’/])([a-z])/g, (_, edge: string, letter: string) => edge + letter.toUpperCase());
    })
    .join(" ");
}

/** "Stripe Test Bank ····6789" - the one way a payout account reads in a picker, rail or preview. */
export function bankAccountLabel(account: { label: string; last4: string }): string {
  return `${titleCaseBankName(account.label)} ····${account.last4}`;
}
