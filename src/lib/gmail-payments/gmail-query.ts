export type PaymentReceiptGmailChannel = "venmo" | "zelle" | "all";

const VENMO_SENDER_QUERY = [
  "from:venmo.com",
  "from:mail.venmo.com",
  "from:e.venmo.com",
  'from:venmo subject:"paid you"',
  'from:venmo subject:"paid your"',
  'from:venmo subject:"completed your"',
].join(" OR ");

const ZELLE_SENDER_QUERY = [
  "from:zellepay.com",
  "from:notify.zellepay.com",
  "from:chase.com",
  "from:bankofamerica.com",
  "from:wellsfargo.com",
  'from:zellepay.com subject:"sent you"',
  'from:zellepay.com subject:"money is on the way"',
  'from:chase.com subject:"Zelle"',
  'from:bankofamerica.com subject:"Zelle"',
  'from:wellsfargo.com subject:"Zelle"',
].join(" OR ");

/** Gmail search query for recent payment notification messages. */
export function buildPaymentReceiptGmailQuery(
  days = 30,
  channel: PaymentReceiptGmailChannel = "all",
): string {
  const d = Math.min(Math.max(days, 1), 90);
  const senderClause =
    channel === "venmo"
      ? VENMO_SENDER_QUERY
      : channel === "zelle"
        ? ZELLE_SENDER_QUERY
        : `(${VENMO_SENDER_QUERY} OR ${ZELLE_SENDER_QUERY})`;
  return [`newer_than:${d}d`, "(", senderClause, ")"].join(" ");
}

/** Plain “From” line for Gmail filter setup (no `from:` prefix). */
export function gmailFilterFromClause(channel: "venmo" | "zelle"): string {
  if (channel === "venmo") {
    return "venmo.com OR mail.venmo.com OR e.venmo.com";
  }
  return "zellepay.com OR notify.zellepay.com OR chase.com OR bankofamerica.com OR wellsfargo.com";
}

/** Optional subject keywords managers can add when the From line alone matches too much mail. */
export function gmailFilterSubjectHint(channel: "venmo" | "zelle"): string {
  return channel === "venmo" ? "paid you" : "Zelle";
}
