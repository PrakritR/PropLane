/** Gmail search query for recent Zelle/Venmo payment notification messages. */
export function buildPaymentReceiptGmailQuery(days = 30): string {
  const d = Math.min(Math.max(days, 1), 90);
  return [
    `newer_than:${d}d`,
    "(",
    "from:venmo.com OR from:mail.venmo.com OR from:e.venmo.com",
    "OR from:zellepay.com OR from:notify.zellepay.com",
    "OR from:chase.com OR from:bankofamerica.com OR from:wellsfargo.com",
    'OR (from:venmo subject:"paid you")',
    'OR (from:venmo subject:"paid your")',
    ")",
  ].join(" ");
}
