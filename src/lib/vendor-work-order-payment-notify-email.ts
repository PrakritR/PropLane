/**
 * Vendor → manager payment notification copy. Shared by the API route and unit tests
 * so preview and delivery always match.
 */

export type VendorWorkOrderPaymentNotifyKind = "send_reminder" | "report_paid";

export type VendorWorkOrderPaymentNotifyEmailInput = {
  vendorName: string;
  workOrderTitle: string;
  propertyLabel: string;
  unit?: string;
  amountLabel: string;
  kind: VendorWorkOrderPaymentNotifyKind;
};

function propertyWhere(input: Pick<VendorWorkOrderPaymentNotifyEmailInput, "propertyLabel" | "unit">): string {
  const unit = input.unit?.trim();
  return unit && unit !== "—" ? `${input.propertyLabel} · ${unit}` : input.propertyLabel;
}

export function buildVendorWorkOrderPaymentNotifyEmail(
  input: VendorWorkOrderPaymentNotifyEmailInput,
): { subject: string; text: string } {
  const where = propertyWhere(input);
  const title = input.workOrderTitle.trim() || "Work order";
  const vendor = input.vendorName.trim() || "Your vendor";
  const amount = input.amountLabel.trim() || "the agreed amount";

  if (input.kind === "report_paid") {
    const subject = `Vendor reports payment received: ${title}`;
    const text = [
      `Hi,`,
      "",
      `${vendor} reports that payment was received for "${title}" at ${where} (${amount}).`,
      "",
      "Please confirm and update the work order in PropLane under Work Orders if anything still shows pending.",
      "",
      "PropLane Portal",
    ].join("\n");
    return { subject, text };
  }

  const subject = `Payment reminder: ${title} — ${amount}`;
  const text = [
    `Hi,`,
    "",
    `${vendor} is following up on payment for "${title}" at ${where}.`,
    "",
    `Amount: ${amount}`,
    "",
    "Please review and approve payment in PropLane under Work Orders when ready.",
    "",
    "PropLane Portal",
  ].join("\n");
  return { subject, text };
}

export type VendorInvoiceReminderEmailInput = {
  vendorName: string;
  /** The service the invoice bills for, else the invoice number. */
  title: string;
  invoiceNumber?: string | null;
  /** Where the work was, when the invoice is tied to a service. */
  where?: string | null;
  amountLabel: string;
};

/** Vendor to manager reminder about an unpaid invoice (Incoming payments, Send reminder). */
export function buildVendorInvoiceReminderEmail(input: VendorInvoiceReminderEmailInput): { subject: string; text: string } {
  const title = input.title.trim() || "Invoice";
  const vendor = input.vendorName.trim() || "Your vendor";
  const amount = input.amountLabel.trim() || "the invoiced amount";
  const number = input.invoiceNumber?.trim();
  const where = input.where?.trim();
  const subject = `Payment reminder: ${title} — ${amount}`;
  const text = [
    "Hi,",
    "",
    `${vendor} is following up on payment for ${number ? `invoice ${number}` : `"${title}"`}${where ? ` at ${where}` : ""}.`,
    "",
    `Amount: ${amount}`,
    "",
    "Please review and pay the invoice in PropLane under Outgoing payments when ready.",
    "",
    "PropLane Portal",
  ].join("\n");
  return { subject, text };
}
