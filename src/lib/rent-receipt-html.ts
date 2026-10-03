import { leaseCss } from "@/lib/lease-templates/types";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type RentReceiptHtmlInput = {
  /** Resident display name or email; omitted from the document when empty. */
  residentName?: string;
  description: string;
  amountLabel: string;
  dateLabel: string;
  /** Card/ACH processing fee line when the resident paid it. */
  processingFeeLabel?: string;
  /** Total charged to the resident (charge + fees) when known. */
  totalChargedLabel?: string;
  /** ISO generation timestamp; defaults to now. */
  generatedAt?: string;
};

/**
 * Clean rendered-document view of a single rent receipt, matching the lease /
 * application document presentation (white page, serif, section table). Meant
 * for an `srcDoc` iframe so the Documents tab can show the receipt without the
 * browser's PDF-viewer chrome; the PDF download remains the official file.
 */
export function buildRentReceiptHtml(input: RentReceiptHtmlInput): string {
  const generated = input.generatedAt ? new Date(input.generatedAt) : new Date();
  const generatedLabel = generated.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" });
  const fields: Array<[string, string]> = [
    ["Received from", (input.residentName ?? "").trim()],
    ["For", input.description.trim()],
    ["Amount paid", input.amountLabel.trim()],
    ...(input.processingFeeLabel?.trim() ? [["Processing fee", input.processingFeeLabel.trim()] as [string, string]] : []),
    ...(input.totalChargedLabel?.trim() ? [["Total charged", input.totalChargedLabel.trim()] as [string, string]] : []),
    ["Payment date", input.dateLabel.trim()],
  ];
  const rows = fields
    .filter(([, value]) => value)
    .map(([label, value]) => `<tr><th width="35%">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join("\n  ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Rent Receipt — ${escapeHtml(input.dateLabel)}</title>
  <style>${leaseCss()}
    html, body { background: #fff; }
    .footnote { margin-top: 2.4rem; border-top: 1px solid #ccc; padding-top: 0.8rem; font-size: 0.8rem; font-style: italic; color: #777; }
  </style>
</head>
<body>
<h1>RENT RECEIPT</h1>
<p class="sub">PropLane Housing Management · Seattle, WA</p>
<p class="generated">Generated ${escapeHtml(generatedLabel)}</p>

<h2>Payment record</h2>
<table>
  ${rows}
</table>

<p class="footnote">Thank you — this receipt confirms your payment was recorded. PropLane Property Management · Confidential</p>
</body>
</html>`;
}
