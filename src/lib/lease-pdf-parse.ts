import type { PropertyLeaseTemplateKind } from "@/lib/property-lease-templates";

export type ParsedLeaseSection = {
  title: string;
  body: string;
};

export type ParsedLeaseDocument = {
  sections: ParsedLeaseSection[];
  inferredKind: PropertyLeaseTemplateKind;
  plainText: string;
};

const SECTION_HEADING_RE =
  /^(?:\d{1,2}[\.)]\s+|(?:ARTICLE|SECTION)\s+[IVXLC\d]+[.:]?\s+)(.+)$/;
const ALL_CAPS_HEADING_RE = /^[A-Z][A-Z0-9\s/&,'()-]{4,}$/;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function paragraphHtml(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const blocks = trimmed.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (blocks.length === 0) return "";
  return blocks
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
}

/** Heuristic split when AI is unavailable — groups numbered / titled blocks. */
export function splitLeaseTextIntoSections(text: string): ParsedLeaseSection[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\f/g, "\n\n").trim();
  if (!normalized) return [];

  const lines = normalized.split("\n");
  const sections: ParsedLeaseSection[] = [];
  let currentTitle = "Lease terms";
  let bodyLines: string[] = [];

  const flush = () => {
    const body = bodyLines.join("\n").trim();
    if (!body) return;
    sections.push({ title: currentTitle, body });
    bodyLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (bodyLines.length > 0) bodyLines.push("");
      continue;
    }
    const headingMatch = SECTION_HEADING_RE.exec(line);
    const allCapsMatch = !headingMatch && ALL_CAPS_HEADING_RE.test(line);
    if (headingMatch || allCapsMatch) {
      flush();
      currentTitle = (headingMatch?.[1] ?? line).replace(/\s+/g, " ").trim();
      continue;
    }
    bodyLines.push(rawLine);
  }
  flush();

  if (sections.length === 0 && normalized) {
    sections.push({ title: currentTitle, body: normalized });
  }

  return sections.filter((s) => s.title.trim() || s.body.trim());
}

/** Guess lease format from extracted document text. */
export function inferLeaseKindFromText(text: string): PropertyLeaseTemplateKind {
  const lower = text.toLowerCase();
  const shortTermSignals =
    /\bshort[- ]term\b|\bnightly\b|\bper night\b|\bcheck[- ]in\b|\bcheck[- ]out\b|\bguest\b|\bfurnished stay\b/.test(
      lower,
    );
  const timeBasedSignals =
    /\btime[- ]based\b|\bper hour\b|\bhourly\b|\bby the hour\b|\bshift\b|\bclock[- ]in\b/.test(lower);
  if (shortTermSignals) return "short-term";
  if (timeBasedSignals) return "time-based";
  return "long-term";
}

const LEASE_HTML_STYLES = `
    body { font-family: Georgia, "Times New Roman", serif; color: #1f2430; margin: 0 auto; max-width: 820px; line-height: 1.55; padding: 28px 24px 40px; }
    h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1px solid #d8dce4; padding-bottom: 4px; margin: 28px 0 12px; }
    p, li { font-size: 14px; }
    .note { color: #5a6172; font-size: 13px; }
    .pdf-frame { width: 100%; min-height: 420px; border: 1px solid #d8dce4; border-radius: 8px; background: #f8f9fb; }
`.trim();

/** Convert parsed sections into editable PropLane lease HTML. */
export function buildProplaneLeaseHtmlFromSections(args: {
  sections: ParsedLeaseSection[];
  docName: string;
  docUrl?: string | null;
  includeSourcePdf?: boolean;
  /** Emit only converted source clauses for a reviewed imported-template base. */
  sourceOnly?: boolean;
}): string {
  const safeName = escapeHtml(args.docName.trim() || "Uploaded lease");
  const sectionHtml = args.sections
    .map((section, index) => {
      const title = section.title.trim() || `Section ${index + 1}`;
      const body = paragraphHtml(section.body);
      if (!section.title.trim() && !body) return "";
      const heading = args.sourceOnly ? title : `${index + 1}. ${title}`;
      return `  <h2>${escapeHtml(heading)}</h2>${body ? `\n${body}` : ""}`;
    })
    .filter(Boolean)
    .join("\n");

  const pdfBlock =
    !args.sourceOnly && args.includeSourcePdf !== false && args.docUrl?.trim()
      ? `
  <h2>${args.sections.length + 1}. Original uploaded document</h2>
  <p class="note">Source PDF retained for reference. PropLane fills resident, room, rent, and dates at signing.</p>
  <iframe class="pdf-frame" title="${safeName}" src="${escapeHtml(args.docUrl)}"></iframe>`
      : "";

  const placementSection = args.sourceOnly ? "" : `
  <h2>${args.sections.length + (pdfBlock ? 2 : 1)}. Placement summary</h2>
  <p>PropLane fills resident name, room, rent, and dates from the approved application when the lease is sent for signature.</p>
  <h2>${args.sections.length + (pdfBlock ? 3 : 2)}. Electronic signature</h2>
  <p>Landlord and Resident each execute this lease through the PropLane portal. The Electronic Signature Certificate is the binding record for both parties.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${safeName}</title>
  <style>
${LEASE_HTML_STYLES}
  </style>
</head>
<body>
${args.sourceOnly ? "" : '  <p class="note">Imported from your uploaded lease and structured for PropLane editing and e-sign.</p>'}
${sectionHtml || "  <h2>1. Lease terms</h2>\n  <p>Review and edit the imported lease sections below.</p>"}
${pdfBlock}
${placementSection}
</body>
</html>`;
}

export function buildCustomBuilderLeaseHtml(title = "Custom lease"): string {
  const safeTitle = escapeHtml(title.trim() || "Custom lease");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${safeTitle}</title>
  <style>
${LEASE_HTML_STYLES}
  </style>
</head>
<body>
  <h2>1. Parties and premises</h2>
  <p>Describe the landlord, resident, and property. PropLane can merge application details at signing.</p>
  <h2>2. Term and rent</h2>
  <p>Set the lease term, rent amount, due date, and any deposits or move-in fees.</p>
  <h2>3. House rules and use</h2>
  <p>Add occupancy limits, quiet hours, smoking policy, and permitted uses.</p>
  <h2>4. Additional provisions</h2>
  <p>Add any custom clauses your team needs.</p>
  <h2>5. Electronic signature</h2>
  <p>Landlord and Resident each execute this lease through the PropLane portal.</p>
</body>
</html>`;
}

export function parseLeasePlainText(text: string, docName: string, docUrl?: string | null): ParsedLeaseDocument {
  const sections = splitLeaseTextIntoSections(text);
  const inferredKind = inferLeaseKindFromText(text);
  return {
    sections,
    inferredKind,
    plainText: text,
  };
}

export function parsedLeaseToHtml(
  parsed: ParsedLeaseDocument,
  docName: string,
  docUrl?: string | null,
): string {
  return buildProplaneLeaseHtmlFromSections({
    sections: parsed.sections,
    docName,
    docUrl,
    sourceOnly: true,
  });
}
