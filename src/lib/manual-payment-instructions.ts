import type { HouseholdCharge } from "@/lib/household-charges";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { generatePaymentReference, generateWorkOrderPaymentReference } from "@/lib/payment-reference";
import { appendResidentPortalLoginInstructions } from "@/lib/resident-portal-login-copy";

export function chargePaymentReference(charge: Pick<HouseholdCharge, "id" | "paymentReference">): string {
  return charge.paymentReference?.trim() || generatePaymentReference(charge.id);
}

export function workOrderPaymentReference(workOrder: Pick<DemoManagerWorkOrderRow, "id" | "paymentReference">): string {
  return workOrder.paymentReference?.trim() || generateWorkOrderPaymentReference(workOrder.id);
}

/** Payment lines for vendor work-order payouts (Zelle/Venmo + WO- reference). */
export function buildWorkOrderPayoutInstructionLines(
  workOrder: Pick<DemoManagerWorkOrderRow, "id" | "paymentReference" | "cost" | "vendorCostCents" | "materialsCostCents"> & {
    zelleContactSnapshot?: string;
    venmoContactSnapshot?: string;
  },
  amountLabel: string,
): string[] {
  const ref = workOrderPaymentReference(workOrder);
  const lines: string[] = [];
  const zelle = workOrder.zelleContactSnapshot?.trim();
  const venmo = workOrder.venmoContactSnapshot?.trim();

  if (zelle || venmo) {
    lines.push("", "Pay with:");
    if (zelle) {
      lines.push(`• Zelle: send ${amountLabel ? `${amountLabel} to ` : "to "}${zelle}`);
      lines.push(`  Memo: ${ref}`);
    }
    if (venmo) {
      lines.push(`• Venmo: send ${amountLabel ? `${amountLabel} to ` : "to "}${venmo}`);
      lines.push(`  Note: ${ref}`);
    }
    lines.push("", "Include the reference code so the vendor can match this payment automatically.");
  } else if (ref) {
    lines.push("", `Payment reference: ${ref}`);
  }

  return lines;
}

/** Payment lines for reminders and resident-facing copy (Zelle/Venmo + PL- reference). */
export function buildManualPaymentInstructionLines(
  charge: Pick<
    HouseholdCharge,
    "id" | "paymentReference" | "zelleContactSnapshot" | "venmoContactSnapshot" | "balanceLabel" | "amountLabel"
  >,
): string[] {
  const ref = chargePaymentReference(charge);
  const amount = charge.balanceLabel?.trim() || charge.amountLabel?.trim() || "";
  const lines: string[] = [];
  const zelle = charge.zelleContactSnapshot?.trim();
  const venmo = charge.venmoContactSnapshot?.trim();

  if (zelle || venmo) {
    lines.push("", "You can pay with:");
    if (zelle) {
      lines.push(`• Zelle: send ${amount ? `${amount} to ` : "to "}${zelle}`);
      lines.push(`  Memo: ${ref}`);
    }
    if (venmo) {
      lines.push(`• Venmo: send ${amount ? `${amount} to ` : "to "}${venmo}`);
      lines.push(`  Note: ${ref}`);
    }
    lines.push("", "Include the reference code in your payment memo so we can match it automatically.");
  } else if (ref) {
    lines.push("", `Payment reference: ${ref}`);
  }

  return lines;
}

export function buildPaymentReminderBody(opts: {
  residentName: string;
  residentEmail?: string;
  chargeTitle: string;
  balanceDue: string;
  dueDate: string;
  propertyLabel: string;
  managerName: string;
  manualPaymentLines?: string[];
}): string {
  const lines = [
    `Hi ${opts.residentName},`,
    "",
    `This is a friendly reminder that your ${opts.chargeTitle} payment is outstanding.`,
  ];
  if (opts.balanceDue) lines.push(`Amount due: ${opts.balanceDue}`);
  if (opts.dueDate) lines.push(`Due date: ${opts.dueDate}`);
  if (opts.propertyLabel) lines.push(`Property: ${opts.propertyLabel}`);

  if (opts.manualPaymentLines?.length) {
    lines.push(...opts.manualPaymentLines);
  }

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
  manualPaymentLines?: string[];
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

  if (opts.manualPaymentLines?.length) {
    lines.push(...opts.manualPaymentLines);
  }

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

/** Append Zelle/Venmo pay-to lines when a charge has manual payment contacts. */
export function appendManualPaymentInstructions(body: string, charge: Parameters<typeof buildManualPaymentInstructionLines>[0]): string {
  const hasManual =
    Boolean(charge.zelleContactSnapshot?.trim()) || Boolean(charge.venmoContactSnapshot?.trim());
  if (!hasManual) return body;
  const extra = buildManualPaymentInstructionLines(charge);
  if (!extra.length) return body;
  const closing = "\n\nIf you have any questions, please don't hesitate to reach out.";
  if (body.includes("If you have any questions")) {
    return body.replace(closing, `${extra.join("\n")}${closing}`);
  }
  return `${body.trim()}${extra.join("\n")}`;
}
