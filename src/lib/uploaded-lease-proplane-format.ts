/**
 * Render a parsed upload in PropLane's own lease format.
 *
 * This is PRESENTATION of the manager's document, not a replacement for it.
 * Every word of body text below is the uploaded document's own text, laid out
 * with the same `leaseCss()` a PropLane-generated lease uses. The renderer
 * never writes a clause, never fills a blank, and never cites a statute — the
 * only sentences it contributes are PropLane's own labels and the provenance
 * notes that tell a reader where a value came from.
 *
 * The uploaded PDF remains the executed artifact: signing appends the
 * certificate page to `managerUploadedPdf.originalDataUrl`, exactly as before
 * (`lease-execution-evidence.ts`). Substituting a machine-derived document for
 * the one the parties agreed to would be a downgrade, not a feature.
 */

import { leaseCss } from "@/lib/lease-templates/types";
import {
  resolvedFieldValue,
  uploadedLeaseReviewIsConfirmed,
  type UploadedLeaseField,
  type UploadedLeaseParse,
  type UploadedLeaseSection,
} from "@/lib/uploaded-lease-extraction";

export type UploadedLeasePlacement = {
  residentName?: string | null;
  residentEmail?: string | null;
  unit?: string | null;
  leaseTerm?: string | null;
  leaseStart?: string | null;
  leaseEnd?: string | null;
  rentLabel?: string | null;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dash(s: string | null | undefined): string {
  const t = (s ?? "").trim();
  return t ? escapeHtml(t) : "—";
}

/** Verbatim body text as paragraphs. Blank lines split; single breaks kept. */
function verbatimHtml(body: string): string {
  const blocks = body.split(/\n{2,}/);
  const rendered = blocks
    .map((block) => block.replace(/^\n+|\n+$/g, ""))
    .filter((block) => block.trim().length > 0)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br/>")}</p>`);
  return rendered.join("\n");
}

const STATUS_NOTE: Record<UploadedLeaseField["status"], string> = {
  extracted: "Read from the document — confirm against the original.",
  ambiguous: "The document states this more than once, in different terms. Left blank for the manager to resolve.",
  not_found: "Not found in the document. Left blank rather than assumed.",
};

function fieldRowHtml(field: UploadedLeaseField, parse: UploadedLeaseParse): string {
  const { value, confirmedByHuman } = resolvedFieldValue(field, parse.review);
  const badge = confirmedByHuman
    ? '<span class="tag tag-human">Confirmed by manager</span>'
    : field.status === "extracted"
      ? '<span class="tag tag-machine">Extracted</span>'
      : '<span class="tag tag-blank">Needs manager review</span>';
  const trace = confirmedByHuman
    ? "Entered by the manager during review."
    : field.source
      ? `Source: page ${field.source.page} — “${escapeHtml(field.source.snippet)}”`
      : STATUS_NOTE[field.status];
  const candidates =
    !confirmedByHuman && field.candidates.length > 0
      ? `<div class="cand">Conflicting readings: ${field.candidates
          .map((c) => `${escapeHtml(c.value)} (p.${c.source.page})`)
          .join(" · ")}</div>`
      : "";
  return `  <tr>
    <th>${escapeHtml(field.label)}</th>
    <td>${value ? `<strong>${escapeHtml(value)}</strong>` : '<span class="blank">—</span>'} ${badge}
      <div class="trace">${trace}</div>${candidates}</td>
  </tr>`;
}

function sectionHtml(section: UploadedLeaseSection, ordinal: number): string {
  const body = verbatimHtml(section.body);
  const title = section.title.trim();
  const heading = title
    ? `<h2>${ordinal}. ${escapeHtml(title)} <span class="pg">page ${section.page}</span></h2>`
    : `<h2>${ordinal}. Preamble <span class="pg">page ${section.page}</span></h2>`;
  // A heading with no body still renders: dropping it would lose source text.
  return `${heading}\n${body || '<p class="blank">(No body text under this heading in the source document.)</p>'}`;
}

const EXTRA_CSS = `
  .banner { border: 1px solid #999; background: #f6f6f4; padding: 10px 12px; margin: 0 0 1.2rem; font-size: 0.85rem; }
  .banner strong { display: block; margin-bottom: 2px; }
  .tag { display: inline-block; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.66rem; letter-spacing: .06em; text-transform: uppercase; border: 1px solid #999; border-radius: 999px; padding: 1px 7px; margin-left: 6px; white-space: nowrap; }
  .tag-human { border-color: #15803d; color: #15803d; }
  .tag-machine { border-color: #a16207; color: #a16207; }
  .tag-blank { border-color: #b91c1c; color: #b91c1c; }
  .trace { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.72rem; color: #555; margin-top: 4px; }
  .cand { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.72rem; color: #b91c1c; margin-top: 3px; }
  .blank { color: #b91c1c; }
  .pg { float: right; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.66rem; letter-spacing: .04em; color: #777; text-transform: none; }
  .verbatim-note { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.75rem; color: #555; margin: 0 0 0.8rem; }
`;

/** Source-only body for signature: no generated placement fields or review labels. */
export function buildUploadedLeaseSignableHtml(parse: UploadedLeaseParse): string {
  const sections = parse.sections.map((section, index) => sectionHtml(section, index + 1)).join("\n\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(parse.sourceFileName)}</title><style>${leaseCss()}${EXTRA_CSS}</style></head><body>
<p class="verbatim-note">Converted from ${escapeHtml(parse.sourceFileName)} · ${parse.pageCount} page${parse.pageCount === 1 ? "" : "s"}</p>
${sections}
</body></html>`;
}

/**
 * PropLane-format HTML for a parsed upload.
 *
 * Section numbering: 1 = placement summary (PropLane's own record), 2 =
 * extracted terms with provenance, then the document's own sections in source
 * order, then the closing note. Every source character appears exactly once —
 * see `assertSectionsPartition`.
 */
export function buildUploadedLeaseProplaneHtml(args: {
  parse: UploadedLeaseParse;
  placement?: UploadedLeasePlacement;
  signableMode?: "original-pdf" | "imported-converted";
}): string {
  const { parse } = args;
  const p = args.placement ?? {};
  const confirmed = uploadedLeaseReviewIsConfirmed(parse);
  const convertedIsSignable = args.signableMode === "imported-converted";
  const title = `Lease Agreement — ${(p.residentName ?? "Resident").trim() || "Resident"}`;

  const banner = confirmed
    ? `<div class="banner"><strong>Reviewed and confirmed by the property manager${
        parse.review.confirmedByName ? ` (${escapeHtml(parse.review.confirmedByName)})` : ""
      }.</strong>Reformatted by PropLane from <em>${escapeHtml(parse.sourceFileName)}</em>. ${convertedIsSignable ? "This converted HTML is the document offered for signature. The original PDF is retained unchanged for comparison." : "The uploaded PDF remains the document that is signed and is retained unchanged."}</div>`
    : `<div class="banner"><strong>Awaiting manager review — not yet available for signature.</strong>Reformatted by PropLane from <em>${escapeHtml(
        parse.sourceFileName,
      )}</em>. Values below were read by machine and have not been confirmed by a person. ${convertedIsSignable ? "The converted HTML may be selected for signature only after this review." : "The uploaded PDF remains the document that is signed and is retained unchanged."}</div>`;

  const placementRows = `
  <tr><th width="32%">Resident / Tenant</th><td>${dash(p.residentName)}${
    p.residentEmail ? `<br/>${escapeHtml(p.residentEmail)}` : ""
  }</td></tr>
  <tr><th>Property / room</th><td>${dash(p.unit)}</td></tr>
  <tr><th>Lease term</th><td>${dash(p.leaseTerm)}</td></tr>
  <tr><th>Lease start</th><td>${dash(p.leaseStart)}</td></tr>
  <tr><th>Lease end</th><td>${dash(p.leaseEnd)}</td></tr>
  <tr><th>Rent on record</th><td>${dash(p.rentLabel)}</td></tr>`;

  const fieldRows = parse.fields.map((field) => fieldRowHtml(field, parse)).join("\n");
  const sections = parse.sections.map((section, i) => sectionHtml(section, i + 3)).join("\n\n");
  const closingOrdinal = parse.sections.length + 3;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title><style>${leaseCss()}${EXTRA_CSS}</style></head><body>
<h1>LEASE AGREEMENT</h1>
<p class="sub">Uploaded document, rendered in PropLane format</p>
<p class="generated">${escapeHtml(parse.sourceFileName)} · ${parse.pageCount} page${
    parse.pageCount === 1 ? "" : "s"
  } · ${parse.characterCount.toLocaleString()} characters read${
    parse.sourceSha256 ? ` · SHA-256 ${escapeHtml(parse.sourceSha256.slice(0, 16))}…` : ""
  }</p>
${banner}

<h2>1. Placement summary (PropLane record)</h2>
<p class="verbatim-note">PropLane's own record of this placement. It is shown for comparison and is not part of the uploaded document.</p>
<table>${placementRows}</table>

<h2>2. Terms read from the document</h2>
<p class="verbatim-note">Each value is either quoted from the document with its page, entered by the manager during review, or left blank. A blank is deliberate: PropLane does not guess a lease term.</p>
<table>
${fieldRows}
</table>

<p class="verbatim-note">Sections 3 onward are the uploaded document's own text, reproduced verbatim in source order. Headings are the document's; nothing has been rewritten, summarized, or omitted.</p>

${sections}

<h2>${closingOrdinal}. Original document and signature</h2>
<p>The uploaded file <strong>${escapeHtml(parse.sourceFileName)}</strong> is retained unchanged and remains the agreement between the parties. Landlord and Resident each execute it once through the PropLane portal; the Electronic Signature Certificate appended to the signed copy is the binding record for both parties.</p>
</body></html>`;
}
