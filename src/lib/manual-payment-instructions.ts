import { appendResidentPortalLoginInstructions } from "@/lib/resident-portal-login-copy";

export function buildPaymentReminderBody(opts: {
  residentName: string;
  residentEmail?: string;
  chargeTitle: string;
  balanceDue: string;
  dueDate: string;
  propertyLabel: string;
  managerName: string;
}): string {
  const lines = [
    `Hi ${opts.residentName},`,
    "",
    `This is a friendly reminder that your ${opts.chargeTitle} payment is outstanding.`,
  ];
  if (opts.balanceDue) lines.push(`Amount due: ${opts.balanceDue}`);
  if (opts.dueDate) lines.push(`Due date: ${opts.dueDate}`);
  if (opts.propertyLabel) lines.push(`Property: ${opts.propertyLabel}`);

  lines.push(
    "",
    "If you have any questions, please don't hesitate to reach out.",
    "",
    opts.managerName,
    "PropLane Portal",
  );
  return appendResidentPortalLoginInstructions(lines.join("\n"), {
    residentEmail: opts.residentEmail,
    afterLoginHint: "payments",
  });
}

/**
 * One reminder covering SEVERAL charges for the same person.
 *
 * A resident with six outstanding charges was sent six separate reminders, each
 * naming one of them — the same message six times over, from their side. Where
 * more than one charge is being chased at once, they belong in one message with
 * the charges itemised and a total, so the resident can see what they owe in a
 * single read.
 */
/**
 * Total a set of already-formatted balance labels ("$1,125.00").
 *
 * Reads the money back out of display strings because that is what the ledger
 * rows carry at this point; returns "" rather than a wrong number if any label
 * does not parse, since a total that is quietly short is worse than no total.
 */
export function sumPaymentBalanceLabels(labels: string[]): string {
  let cents = 0;
  for (const label of labels) {
    const digits = label.replace(/[^0-9.]/g, "");
    if (!digits) return "";
    const value = Number(digits);
    if (!Number.isFinite(value)) return "";
    cents += Math.round(value * 100);
  }
  if (cents <= 0) return "";
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function buildCombinedPaymentReminderBody(opts: {
  residentName: string;
  residentEmail?: string;
  charges: { title: string; balanceDue: string; dueDate: string }[];
  propertyLabel: string;
  managerName: string;
  totalLabel?: string;
}): string {
  const count = opts.charges.length;
  const lines = [
    `Hi ${opts.residentName},`,
    "",
    `This is a friendly reminder that you have ${count} outstanding payments.`,
    "",
  ];
  for (const charge of opts.charges) {
    const detail = [charge.balanceDue, charge.dueDate ? `due ${charge.dueDate}` : ""]
      .filter(Boolean)
      .join(" · ");
    lines.push(detail ? `• ${charge.title} — ${detail}` : `• ${charge.title}`);
  }
  if (opts.totalLabel) lines.push("", `Total outstanding: ${opts.totalLabel}`);
  if (opts.propertyLabel) lines.push(`Property: ${opts.propertyLabel}`);

  lines.push(
    "",
    "If you have any questions, please don't hesitate to reach out.",
    "",
    opts.managerName,
    "PropLane Portal",
  );
  return appendResidentPortalLoginInstructions(lines.join("\n"), {
    residentEmail: opts.residentEmail,
    afterLoginHint: "payments",
  });
}
