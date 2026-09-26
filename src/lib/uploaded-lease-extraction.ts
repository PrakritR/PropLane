/**
 * Parsing a manager-uploaded lease PDF into PropLane's own structure.
 *
 * A lease is a legal document, so three rules shape every function here and
 * none of them are negotiable:
 *
 * 1. **Nothing is invented.** A field is emitted only when the document says it
 *    exactly once. Two disagreeing matches produce `ambiguous` with an EMPTY
 *    value and both candidates listed; no match produces `not_found` with an
 *    empty value. There is no default, no "most likely", no nearest guess. A
 *    confidently wrong rent figure is far worse than a blank one.
 * 2. **No text is authored.** Sections carry the document's own bytes. This
 *    module never writes a clause, never paraphrases, never normalizes wording,
 *    and never emits a statute citation (see `AGENTS.md` — PropLane does not
 *    author citations anywhere). Reformatting is presentation only.
 * 3. **Nothing is lost.** `splitLeasePagesIntoSections` PARTITIONS the extracted
 *    text: the sections tile `[0, text.length)` end to end with no gaps and no
 *    overlap, so every character of the source reaches the rendered document
 *    even when it belongs to no recognizable section. `assertSectionsPartition`
 *    is the executable form of that promise and the unit tests drive it.
 *
 * Traceability is what makes the manager's review step real rather than
 * theatre: every field and every section records the page and character span it
 * came from, plus the surrounding snippet, so a reviewer can find it in the
 * original PDF.
 *
 * Deliberately dependency-free and isomorphic: the server extracts page text
 * with `unpdf` and calls in here, and the browser re-renders the same structure
 * without shipping a PDF stack.
 */

export const UPLOADED_LEASE_PARSE_VERSION = 1 as const;

/**
 * Beyond this the document is not structured at all. Truncating a lease to fit
 * a storage budget would silently drop terms, which is the one failure mode
 * this module exists to prevent — so it fails loudly instead and the manager
 * keeps reading the original PDF.
 */
export const MAX_EXTRACTABLE_CHARS = 300_000;

export type UploadedLeaseFieldKey =
  | "landlordName"
  | "tenantName"
  | "propertyAddress"
  | "leaseStart"
  | "leaseEnd"
  | "monthlyRent"
  | "securityDeposit"
  | "rentDueDay"
  | "lateFee";

export type UploadedLeaseFieldStatus = "extracted" | "ambiguous" | "not_found";

/** Where in the source document a value came from. */
export type UploadedLeaseSourceRef = {
  /** 1-based page of the uploaded PDF. */
  page: number;
  /** Character span into the joined plain text (`UploadedLeaseText.text`). */
  charStart: number;
  charEnd: number;
  /** Surrounding text, for a reviewer comparing against the original. */
  snippet: string;
};

export type UploadedLeaseFieldCandidate = {
  value: string;
  source: UploadedLeaseSourceRef;
};

export type UploadedLeaseField = {
  key: UploadedLeaseFieldKey;
  label: string;
  status: UploadedLeaseFieldStatus;
  /** Verbatim from the document. EMPTY unless `status === "extracted"`. */
  value: string;
  /**
   * Machine-comparable form, and only when the source form is unambiguous —
   * a month-name or ISO date, a currency amount. `01/02/2026` is left null
   * because it means two different days in two conventions, and picking one
   * would be inventing a term.
   */
  normalized: string | null;
  source: UploadedLeaseSourceRef | null;
  /** Populated only for `ambiguous`: every distinct reading found. */
  candidates: UploadedLeaseFieldCandidate[];
  /**
   * The field on PropLane's own model this corresponds to, or null when
   * PropLane has no home for it (review-only). Documentation, not a writer:
   * confirming a parse never overwrites PropLane's records.
   */
  mapsTo: string | null;
};

export type UploadedLeaseSection = {
  index: number;
  /** The heading line exactly as printed, or "" for text before any heading. */
  title: string;
  /** Everything under that heading, verbatim. */
  body: string;
  /** 1-based page the section starts on. */
  page: number;
  charStart: number;
  charEnd: number;
};

export type UploadedLeaseReview = {
  status: "needs_review" | "confirmed";
  confirmedByUserId?: string | null;
  confirmedByName?: string | null;
  confirmedAtIso?: string | null;
  /**
   * WHAT the manager confirmed: the `sourceSha256` of the parse they attested
   * to. A confirmation that records only who and when survives the document
   * underneath it changing, which would let an attestation against one lease
   * authorize the signing of another — so the digest is stamped here at confirm
   * time and re-checked on every read
   * (`uploadedLeaseNeedsManagerConfirmation`).
   */
  confirmedDocumentSha256?: string | null;
  /** Hash of the exact converted HTML the manager reviewed, when choosing it to sign. */
  confirmedConvertedHtmlSha256?: string | null;
  /** Source issue codes the manager resolved by editing the exact converted HTML. */
  resolvedSourceIssueCodes?: string[];
  /**
   * The OTHER half of what was confirmed: a fingerprint of the lease record's
   * own terms at confirm time (`leaseRecordFingerprint`).
   *
   * `confirmedDocumentSha256` pins the document; this pins what the document
   * was compared AGAINST. Without it, a manager who accepts a document's
   * differences and then edits the resident's rent or dates has their
   * acknowledgement silently carried onto terms they never saw — the document
   * never changed, so the digest still matches, and the parties-mismatch guard
   * would wave the send through.
   *
   * Absent means the confirmation predates this field. That is treated as "does
   * not cover the record" wherever a mismatch actually exists — see
   * `leaseMismatchAcknowledged`.
   */
  confirmedRecordFingerprint?: string | null;
  /**
   * Values a human typed. Presence of a key is what marks a value
   * human-confirmed rather than machine-extracted, and the review UI and the
   * rendered document both distinguish the two.
   */
  overrides?: Partial<Record<UploadedLeaseFieldKey, string>>;
  /** Free-text note the manager left at confirmation time. */
  note?: string | null;
};

export type UploadedLeaseParse = {
  version: typeof UPLOADED_LEASE_PARSE_VERSION;
  /**
   * `pending` is written the instant the PDF lands, BEFORE any text is read,
   * so the confirm-before-sign gate is closed for the whole window in which a
   * parse could still be running or could fail.
   */
  status: "pending" | "parsed" | "failed";
  sourceFileName: string;
  /** SHA-256 of the uploaded bytes, tying this parse to one exact document. */
  sourceSha256: string | null;
  pageCount: number;
  characterCount: number;
  extractedAtIso: string | null;
  sections: UploadedLeaseSection[];
  fields: UploadedLeaseField[];
  failureReason?: string | null;
  /** Source extraction diagnostics. Missing on legacy parses, which remain original-PDF only. */
  sourceIssues?: Array<{ pageNumber: number | null; code: string; message: string }>;
  sourceCoverage?: {
    extractedCharacters: number;
    representedCharacters: number;
    complete: boolean;
  };
  review: UploadedLeaseReview;
};

export type UploadedLeaseText = {
  /** Page texts joined by `PAGE_SEPARATOR`, the coordinate space for every span. */
  text: string;
  /** `pageStarts[i]` is the char offset of page `i + 1` in `text`. */
  pageStarts: number[];
  pageCount: number;
};

const PAGE_SEPARATOR = "\n\n";

/** Join per-page text into one coordinate space, keeping page boundaries. */
export function joinLeasePages(pages: string[]): UploadedLeaseText {
  const pageStarts: number[] = [];
  let text = "";
  pages.forEach((raw, index) => {
    const normalized = String(raw ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (index > 0) text += PAGE_SEPARATOR;
    pageStarts.push(text.length);
    text += normalized;
  });
  return { text, pageStarts, pageCount: pages.length };
}

/** 1-based page containing a character offset. */
export function pageForOffset(doc: UploadedLeaseText, offset: number): number {
  if (doc.pageStarts.length === 0) return 1;
  let page = 1;
  for (let i = 0; i < doc.pageStarts.length; i++) {
    if (offset >= doc.pageStarts[i]!) page = i + 1;
    else break;
  }
  return page;
}

function snippetAround(doc: UploadedLeaseText, start: number, end: number, pad = 60): string {
  const from = Math.max(0, start - pad);
  const to = Math.min(doc.text.length, end + pad);
  return doc.text.slice(from, to).replace(/\s+/g, " ").trim();
}

function sourceRef(doc: UploadedLeaseText, start: number, end: number): UploadedLeaseSourceRef {
  return {
    page: pageForOffset(doc, start),
    charStart: start,
    charEnd: end,
    snippet: snippetAround(doc, start, end),
  };
}

/* ------------------------------------------------------------------ *
 * Section splitting — lossless by construction
 * ------------------------------------------------------------------ */

const NUMBERED_HEADING_RE = /^(?:\d{1,2}(?:\.\d{1,2})*[.)]\s+\S|(?:ARTICLE|SECTION)\s+[IVXLC\d]+\b)/;
const ALL_CAPS_HEADING_RE = /^[A-Z][A-Z0-9\s/&,'()."-]{4,79}$/;

function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 120) return false;
  if (NUMBERED_HEADING_RE.test(trimmed)) return true;
  // An all-caps line is a heading only if it is not a full sentence of prose.
  if (ALL_CAPS_HEADING_RE.test(trimmed) && !/[.!?]\s+\S/.test(trimmed)) return true;
  return false;
}

/**
 * Split extracted text into sections that PARTITION it exactly.
 *
 * Heading detection is heuristic and allowed to be wrong; losslessness is not.
 * A block that matches no heading pattern becomes an untitled section rather
 * than being dropped, so unrecognized content still reaches the reader.
 */
export function splitLeasePagesIntoSections(doc: UploadedLeaseText): UploadedLeaseSection[] {
  const { text } = doc;
  if (!text) return [];

  // Offsets of every line start, so a heading's span is exact.
  const boundaries: number[] = [];
  let cursor = 0;
  while (cursor <= text.length) {
    boundaries.push(cursor);
    const next = text.indexOf("\n", cursor);
    if (next === -1) break;
    cursor = next + 1;
  }

  const headingStarts: number[] = [];
  for (const start of boundaries) {
    const lineEnd = text.indexOf("\n", start);
    const line = text.slice(start, lineEnd === -1 ? text.length : lineEnd);
    if (isHeadingLine(line)) headingStarts.push(start);
  }

  const headingStartSet = new Set(headingStarts);
  const cuts = headingStarts[0] === 0 ? [...headingStarts] : [0, ...headingStarts];
  const sections: UploadedLeaseSection[] = [];
  cuts.forEach((start, i) => {
    const end = i + 1 < cuts.length ? cuts[i + 1]! : text.length;
    const slice = text.slice(start, end);
    const isHeading = headingStartSet.has(start);
    const firstBreak = slice.indexOf("\n");
    const title = isHeading ? slice.slice(0, firstBreak === -1 ? slice.length : firstBreak).trim() : "";
    const body = isHeading ? slice.slice(firstBreak === -1 ? slice.length : firstBreak + 1) : slice;
    sections.push({
      index: sections.length,
      title,
      body,
      page: pageForOffset(doc, start),
      charStart: start,
      charEnd: end,
    });
  });
  return sections;
}

/**
 * The losslessness promise, executable. Throws when the sections fail to tile
 * the source exactly, or when title + body loses a non-whitespace character.
 */
export function assertSectionsPartition(doc: UploadedLeaseText, sections: UploadedLeaseSection[]): void {
  if (!doc.text) {
    if (sections.length > 0) throw new Error("sections produced from empty text");
    return;
  }
  if (sections.length === 0) throw new Error("no sections produced from non-empty text");
  if (sections[0]!.charStart !== 0) throw new Error("sections do not start at 0");
  for (let i = 1; i < sections.length; i++) {
    if (sections[i]!.charStart !== sections[i - 1]!.charEnd) {
      throw new Error(`gap or overlap between sections ${i - 1} and ${i}`);
    }
  }
  if (sections[sections.length - 1]!.charEnd !== doc.text.length) {
    throw new Error("sections do not cover the end of the text");
  }
  const strip = (s: string) => s.replace(/\s+/g, "");
  const rendered = strip(sections.map((s) => s.title + s.body).join(""));
  if (rendered !== strip(doc.text)) throw new Error("section text does not reproduce the source");
}

/* ------------------------------------------------------------------ *
 * Field extraction — one unambiguous reading, or nothing
 * ------------------------------------------------------------------ */

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
  jan: "01", feb: "02", mar: "03", apr: "04", jun: "06", jul: "07", aug: "08",
  sep: "09", sept: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * ISO form, ONLY for date shapes that mean one thing in every convention.
 * `03/04/2026` is left unnormalized on purpose: it is 3 April in most of the
 * world and 4 March in the US, and a lease is not the place to pick one.
 */
export function normalizeLeaseDate(raw: string): string | null {
  const value = raw.trim().replace(/\s+/g, " ");
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const monthFirst = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(value);
  if (monthFirst) {
    const month = MONTHS[monthFirst[1]!.toLowerCase()];
    if (month) return `${monthFirst[3]}-${month}-${monthFirst[2]!.padStart(2, "0")}`;
  }
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:day\s+of\s+)?([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(value);
  if (dayFirst) {
    const month = MONTHS[dayFirst[2]!.toLowerCase()];
    if (month) return `${dayFirst[3]}-${month}-${dayFirst[1]!.padStart(2, "0")}`;
  }
  return null;
}

/** "$2,150" / "2150.00" -> "2150.00". Null when it is not a plain amount. */
export function normalizeLeaseMoney(raw: string): string | null {
  const cleaned = raw.trim().replace(/[$\s,]/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

const DATE_SRC = String.raw`(?:\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:day\s+of\s+)?[A-Za-z]{3,9}\.?,?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})`;
const MONEY_SRC = String.raw`\$\s?\d[\d,]*(?:\.\d{2})?`;
const PARTY_SRC = String.raw`[A-Z][^\n,;()]{1,78}`;

type FieldMatcher = {
  key: UploadedLeaseFieldKey;
  label: string;
  mapsTo: string | null;
  patterns: RegExp[];
  normalize: (raw: string) => string | null;
  /** Reject a capture that is obviously not this kind of value. */
  accept?: (raw: string) => boolean;
};

const NON_NAME_WORDS =
  /\b(?:agreement|lease|premises|property|tenant|landlord|lessor|lessee|hereinafter|whose|address|dated|between)\b/i;

function acceptPartyName(raw: string): boolean {
  const value = raw.trim().replace(/[.,;:]+$/, "");
  if (value.length < 3 || value.length > 80) return false;
  if (/\d/.test(value)) return false;
  if (NON_NAME_WORDS.test(value)) return false;
  return /[A-Za-z]/.test(value);
}

const FIELD_MATCHERS: FieldMatcher[] = [
  {
    key: "landlordName",
    label: "Landlord / Lessor",
    // PropLane derives the landlord from the manager account; there is no
    // free-text landlord field on a lease row. Review-only.
    mapsTo: null,
    patterns: [
      new RegExp(String.raw`\b(?:Landlord|Lessor)\s*(?:\(s\))?\s*(?:name)?\s*[:–—-]\s*(${PARTY_SRC})`, "g"),
      new RegExp(String.raw`between\s+(${PARTY_SRC}?)\s*\(\s*(?:the\s+)?["'“]?(?:Landlord|Lessor)`, "gi"),
    ],
    normalize: () => null,
    accept: acceptPartyName,
  },
  {
    key: "tenantName",
    label: "Tenant / Resident",
    mapsTo: "LeasePipelineRow.residentName",
    patterns: [
      new RegExp(String.raw`\b(?:Tenant|Lessee|Resident)\s*(?:\(s\))?\s*(?:name)?\s*[:–—-]\s*(${PARTY_SRC})`, "g"),
      new RegExp(String.raw`\band\s+(${PARTY_SRC}?)\s*\(\s*(?:the\s+)?["'“]?(?:Tenant|Lessee|Resident)`, "gi"),
    ],
    normalize: () => null,
    accept: acceptPartyName,
  },
  {
    key: "propertyAddress",
    label: "Premises address",
    // `LeasePipelineRow.unit` is a placement label derived from the listing,
    // not the document's free-text address. Review-only.
    mapsTo: null,
    patterns: [
      /\b(?:premises|property)\s+(?:commonly\s+)?(?:known\s+as|located\s+at)\s*[:,]?\s*([^\n]{6,120})/gi,
      /\bpremises\s+address\s*[:–—-]\s*([^\n]{6,120})/gi,
    ],
    normalize: () => null,
    accept: (raw) => raw.trim().length >= 6,
  },
  {
    key: "leaseStart",
    label: "Lease start",
    mapsTo: "LeasePipelineRow.application.leaseStart",
    patterns: [
      new RegExp(String.raw`\b(?:commenc\w+|begin\w*|start\w*)\s+(?:on\s+)?(${DATE_SRC})`, "gi"),
      new RegExp(String.raw`\b(?:term|tenancy)\b[^\n]{0,60}?\bfrom\s+(${DATE_SRC})`, "gi"),
      new RegExp(String.raw`\b(?:lease\s+start|start\s+date|move[- ]in\s+date)\s*[:–—-]\s*(${DATE_SRC})`, "gi"),
    ],
    normalize: normalizeLeaseDate,
  },
  {
    key: "leaseEnd",
    label: "Lease end",
    mapsTo: "LeasePipelineRow.application.leaseEnd",
    patterns: [
      new RegExp(String.raw`\b(?:end\w*|terminat\w+|expir\w+)\s+(?:on\s+)?(${DATE_SRC})`, "gi"),
      new RegExp(String.raw`\b(?:through|until)\s+(${DATE_SRC})`, "gi"),
      new RegExp(String.raw`\b(?:lease\s+end|end\s+date|move[- ]out\s+date)\s*[:–—-]\s*(${DATE_SRC})`, "gi"),
    ],
    normalize: normalizeLeaseDate,
  },
  {
    key: "monthlyRent",
    label: "Monthly rent",
    mapsTo: "LeasePipelineRow.signedRentLabel",
    patterns: [
      new RegExp(String.raw`\bmonthly\s+rent\b[^\n$]{0,60}?(${MONEY_SRC})`, "gi"),
      new RegExp(String.raw`\brent\b[^\n$]{0,40}?(${MONEY_SRC})\s*(?:per\s+month|/\s*month|a\s+month|monthly)`, "gi"),
      new RegExp(String.raw`(${MONEY_SRC})\s*(?:per\s+month|/\s*month)\b`, "gi"),
    ],
    normalize: normalizeLeaseMoney,
  },
  {
    key: "securityDeposit",
    label: "Security deposit",
    mapsTo: "DemoApplicantRow.manualResidentDetails.securityDeposit",
    patterns: [new RegExp(String.raw`\bsecurity\s+deposit\b[^\n$]{0,80}?(${MONEY_SRC})`, "gi")],
    normalize: normalizeLeaseMoney,
  },
  {
    key: "rentDueDay",
    label: "Rent due day",
    // Due dates come from PropLane's generated charge schedule, not the row.
    mapsTo: null,
    patterns: [
      /\bdue\b[^\n.]{0,40}?\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\s+day\b/gi,
      /\bon\s+the\s+(\d{1,2})(?:st|nd|rd|th)\s+of\s+each\s+(?:calendar\s+)?month\b/gi,
    ],
    normalize: (raw) => {
      const n = Number(raw.trim());
      return Number.isInteger(n) && n >= 1 && n <= 31 ? String(n) : null;
    },
  },
  {
    key: "lateFee",
    label: "Late fee",
    // Late fees come from manager automation settings, not the lease row.
    mapsTo: null,
    patterns: [new RegExp(String.raw`\blate\s+(?:fee|charge|payment\s+fee)\b[^\n$]{0,80}?(${MONEY_SRC})`, "gi")],
    normalize: normalizeLeaseMoney,
  },
];

/** Distinct readings of one field, keyed on the comparable form when there is one. */
function collectMatches(
  doc: UploadedLeaseText,
  matcher: FieldMatcher,
): Map<string, UploadedLeaseFieldCandidate> {
  const found = new Map<string, UploadedLeaseFieldCandidate>();
  for (const pattern of matcher.patterns) {
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = re.exec(doc.text)) !== null) {
      if (match.index === re.lastIndex) re.lastIndex += 1; // zero-width guard
      const captured = match[1];
      if (!captured) continue;
      const value = captured.trim().replace(/[.,;:]+$/, "");
      if (!value) continue;
      if (matcher.accept && !matcher.accept(value)) continue;
      const start = doc.text.indexOf(captured, match.index);
      const at = start === -1 ? match.index : start;
      const key = (matcher.normalize(value) ?? value.toLowerCase().replace(/\s+/g, " ")).trim();
      if (found.has(key)) continue;
      found.set(key, { value, source: sourceRef(doc, at, at + captured.length) });
    }
  }
  return found;
}

/**
 * One field per matcher. Exactly one distinct reading -> `extracted`. More than
 * one -> `ambiguous` with an empty value and the candidates listed for the
 * manager to choose between. None -> `not_found` with an empty value.
 */
export function extractLeaseFields(doc: UploadedLeaseText): UploadedLeaseField[] {
  return FIELD_MATCHERS.map((matcher) => {
    const found = [...collectMatches(doc, matcher).values()];
    const base = { key: matcher.key, label: matcher.label, mapsTo: matcher.mapsTo };
    if (found.length === 1) {
      const only = found[0]!;
      return {
        ...base,
        status: "extracted" as const,
        value: only.value,
        normalized: matcher.normalize(only.value),
        source: only.source,
        candidates: [],
      };
    }
    if (found.length > 1) {
      return {
        ...base,
        status: "ambiguous" as const,
        value: "",
        normalized: null,
        source: null,
        candidates: found.slice(0, 6),
      };
    }
    return { ...base, status: "not_found" as const, value: "", normalized: null, source: null, candidates: [] };
  });
}

/* ------------------------------------------------------------------ *
 * Assembly + review state
 * ------------------------------------------------------------------ */

/** The state written the moment a PDF lands, before any text is read. */
export function pendingUploadedLeaseParse(fileName: string): UploadedLeaseParse {
  return {
    version: UPLOADED_LEASE_PARSE_VERSION,
    status: "pending",
    sourceFileName: fileName,
    sourceSha256: null,
    pageCount: 0,
    characterCount: 0,
    extractedAtIso: null,
    sections: [],
    fields: [],
    review: { status: "needs_review" },
  };
}

export function failedUploadedLeaseParse(fileName: string, reason: string): UploadedLeaseParse {
  return { ...pendingUploadedLeaseParse(fileName), status: "failed", failureReason: reason };
}

export const UNREAD_UPLOADED_LEASE_REASON =
  "PropLane has no reading of this document. It was uploaded before import parsing existed, or the read never ran.";

/**
 * The reading of an upload that was never read at all.
 *
 * "No parse" used to mean "no gate": an uploaded contract with no
 * `uploadedLeaseParse` was sent for signature with no review step of any kind.
 * That is the state every legacy and seeded upload is in, so the escape hatch
 * was wider than the rule. Synthesizing this record instead makes the absence
 * explicit — an unread document is an unreviewed one — and it reaches the same
 * review modal, so it is held rather than stranded.
 *
 * `failed` rather than `pending` on purpose: `pending` means a read is running
 * and offers no confirm affordance, which would be a one-way door.
 */
export function unreadUploadedLeaseParse(fileName: string): UploadedLeaseParse {
  return failedUploadedLeaseParse(fileName, UNREAD_UPLOADED_LEASE_REASON);
}

/** True when this reading records that no read was ever attempted. */
export function uploadedLeaseWasNeverRead(parse: UploadedLeaseParse | null | undefined): boolean {
  return parse?.status === "failed" && parse.failureReason === UNREAD_UPLOADED_LEASE_REASON;
}

export function buildUploadedLeaseParse(args: {
  pages: string[];
  fileName: string;
  sourceSha256: string | null;
  extractedAtIso: string;
  sourceIssues?: Array<{ pageNumber: number | null; code: string; message: string }>;
  sourceCoverage?: UploadedLeaseParse["sourceCoverage"];
}): UploadedLeaseParse {
  const doc = joinLeasePages(args.pages);
  if (!doc.text.trim()) {
    return {
      ...failedUploadedLeaseParse(
      args.fileName,
      "No text could be read from this PDF. It may be a scan or an image-only export — review the original document instead.",
      ),
      sourceSha256: args.sourceSha256,
      sourceIssues: args.sourceIssues,
      sourceCoverage: args.sourceCoverage,
    };
  }
  if (doc.text.length > MAX_EXTRACTABLE_CHARS) {
    return {
      ...failedUploadedLeaseParse(
      args.fileName,
      `This document is ${doc.text.length.toLocaleString()} characters, past the ${MAX_EXTRACTABLE_CHARS.toLocaleString()} limit for structuring. It was not shortened — review the original document instead.`,
      ),
      sourceSha256: args.sourceSha256,
      sourceIssues: args.sourceIssues,
      sourceCoverage: args.sourceCoverage,
    };
  }
  const sections = splitLeasePagesIntoSections(doc);
  assertSectionsPartition(doc, sections);
  return {
    version: UPLOADED_LEASE_PARSE_VERSION,
    status: "parsed",
    sourceFileName: args.fileName,
    sourceSha256: args.sourceSha256,
    pageCount: doc.pageCount,
    characterCount: doc.text.length,
    extractedAtIso: args.extractedAtIso,
    sections,
    fields: extractLeaseFields(doc),
    sourceIssues: args.sourceIssues,
    sourceCoverage: args.sourceCoverage,
    review: { status: "needs_review" },
  };
}

/** The value to show for a field, and whether a human stands behind it. */
export function resolvedFieldValue(
  field: UploadedLeaseField,
  review: UploadedLeaseReview,
): { value: string; confirmedByHuman: boolean } {
  const override = review.overrides?.[field.key];
  if (typeof override === "string" && override.trim()) {
    return { value: override.trim(), confirmedByHuman: true };
  }
  return { value: field.value, confirmedByHuman: false };
}

/**
 * True while a parsed lease still needs a manager to confirm it.
 *
 * This and its inverse `uploadedLeaseReviewIsConfirmed` are THE decision for
 * "has a human confirmed this reading". Every consumer — the gate, the review
 * modal, the header buttons, the rendered document — must go through one of
 * them. Reading `review.status` directly anywhere else re-implements a weaker
 * rule and lets the UI claim a lease is confirmed while the gate holds it.
 *
 * A confirmation counts only when it is bound to the document it was made
 * against: `review.confirmedDocumentSha256` must equal the parse's current
 * `sourceSha256`. An absent or mismatched digest reads as `needs_review`.
 *
 * What that binding proves, and what it does not:
 *
 * - It proves the confirmation belongs to the PARSE it was made against. A
 *   re-read that produces a different digest, or a parse swapped for one
 *   describing other bytes, drops back to `needs_review`.
 * - It does NOT prove the parse describes the bytes currently in
 *   `managerUploadedPdf`. Both values live inside the same
 *   `row_data.uploadedLeaseParse` blob, so this is an internal-consistency
 *   check, not a byte-level one. A real byte check would need to hash the
 *   upload, which this synchronous render-path predicate cannot do.
 * - It does NOT close the `row_data` trust problem. That blob is writable by
 *   the row's own resident through the lease-pipeline route, and a forged blob
 *   can satisfy this check by naming its own digest on both sides. Closing that
 *   belongs to the lease-pipeline route lane, not here.
 *
 * The one deliberate exception is a parse that has no digest of its own
 * (`sourceSha256: null` — a `pending` parse written before any text was read, a
 * `failed` one, a row from before this field existed, or a stored digest that
 * failed the 64-hex check in `normalizeUploadedLeaseParse` and so normalized to
 * null). There is nothing to bind such a confirmation to, so it reads as
 * confirmed on the who-and-when alone. Requiring a digest there would make
 * those leases permanently unconfirmable with no way out — a dead end, not a
 * gate. This never loosens a parse that does carry a digest.
 */
export function uploadedLeaseNeedsManagerConfirmation(parse: UploadedLeaseParse | null | undefined): boolean {
  if (!parse) return false;
  if (parse.review.status !== "confirmed") return true;
  if (!parse.sourceSha256) return false;
  return parse.review.confirmedDocumentSha256 !== parse.sourceSha256;
}

/**
 * Whether a human has confirmed THIS reading — the one question every surface
 * asks. See `uploadedLeaseNeedsManagerConfirmation` for what the underlying
 * digest binding does and does not prove.
 *
 * A parse that is absent is not "confirmed": a row with no parse has nothing to
 * confirm, and its callers gate on the parse's presence first.
 */
export function uploadedLeaseReviewIsConfirmed(parse: UploadedLeaseParse | null | undefined): boolean {
  if (!parse) return false;
  return !uploadedLeaseNeedsManagerConfirmation(parse);
}

/** One conversion policy for the review surface, confirmation, and send gate. */
export function uploadedLeaseConversionBlocker(
  parse: UploadedLeaseParse | null | undefined,
  resolvedCodes: readonly string[] = [],
): string | null {
  if (!parse?.sourceSha256 || !parse.sourceCoverage?.complete) return "The original PDF has incomplete extraction coverage.";
  if (parse.status === "pending") return "The original PDF is still being read.";
  const unresolved = (parse.sourceIssues ?? []).filter((issue) => !resolvedCodes.includes(uploadedLeaseSourceIssueKey(issue)));
  if (unresolved.length) return "Resolve every source-page issue against the original PDF before using the converted lease.";
  if (parse.status !== "parsed" && !(parse.status === "failed" && (parse.sourceIssues ?? []).some((issue) => issue.code === "unreadable_page"))) {
    return "This PDF could not be safely converted. Use the original PDF.";
  }
  return null;
}

export function uploadedLeaseSourceIssueKey(issue: { pageNumber: number | null; code: string }): string {
  return `${issue.pageNumber ?? 0}:${issue.code}`;
}

export function confirmedUploadedLeaseReview(
  review: UploadedLeaseReview,
  by: {
    userId?: string | null;
    name?: string | null;
    atIso: string;
    note?: string | null;
    /** The `sourceSha256` of the parse being confirmed; null when it has none. */
    documentSha256?: string | null;
    /** SHA-256 of the exact converted HTML approved for signature. */
    convertedHtmlSha256?: string | null;
    resolvedSourceIssueCodes?: string[];
    /** Fingerprint of the record's terms at confirm time; null when unknown. */
    recordFingerprint?: string | null;
  },
): UploadedLeaseReview {
  return {
    ...review,
    status: "confirmed",
    confirmedByUserId: by.userId ?? null,
    confirmedByName: by.name ?? null,
    confirmedAtIso: by.atIso,
    confirmedDocumentSha256: by.documentSha256 ?? null,
    confirmedConvertedHtmlSha256: by.convertedHtmlSha256 ?? null,
    resolvedSourceIssueCodes: [...new Set(by.resolvedSourceIssueCodes ?? [])].filter((code) => typeof code === "string").slice(0, 120),
    confirmedRecordFingerprint: by.recordFingerprint ?? null,
    note: by.note?.trim() || null,
  };
}

const FIELD_KEYS = new Set<string>(FIELD_MATCHERS.map((m) => m.key));
const FIELD_LABELS = new Map<string, string>(FIELD_MATCHERS.map((m) => [m.key, m.label]));
const FIELD_MAPS_TO = new Map<string, string | null>(FIELD_MATCHERS.map((m) => [m.key, m.mapsTo]));
const FIELD_STATUSES = new Set<string>(["extracted", "ambiguous", "not_found"]);

/** The parse could not be interpreted, so it holds the lease instead of releasing it. */
const UNREADABLE_PARSE_REASON =
  "PropLane's stored reading of this document could not be interpreted, so nothing from it is shown. The uploaded PDF is unchanged — read the original and confirm it yourself.";

function unreadableVersionReason(version: unknown): string {
  const printed = typeof version === "number" && Number.isFinite(version) ? String(version) : "unknown";
  return `PropLane's stored reading of this document is in format version ${printed}, which this build cannot interpret, so nothing from it is shown. The uploaded PDF is unchanged — read the original and confirm it yourself.`;
}

function coerceText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function coerceOffset(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function coercePage(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function normalizeSourceRef(raw: unknown): UploadedLeaseSourceRef | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  return {
    page: coercePage(s.page),
    charStart: coerceOffset(s.charStart),
    charEnd: coerceOffset(s.charEnd),
    snippet: coerceText(s.snippet),
  };
}

function normalizeCandidate(raw: unknown): UploadedLeaseFieldCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const value = coerceText(c.value).trim();
  if (!value) return null;
  return { value, source: normalizeSourceRef(c.source) ?? { page: 1, charStart: 0, charEnd: 0, snippet: "" } };
}

/**
 * One stored field, coerced so no renderer can be handed a missing string, an
 * unknown status, or a missing candidate list. A row this shape cannot be
 * repaired into (wrong key, not an object) is dropped rather than guessed at.
 *
 * `value` is cleared for anything but `extracted`, which is the module's own
 * blank-and-flagged rule enforced on the way IN as well as on the way out — a
 * tampered blob must not be able to present an unread term as a read one.
 */
function normalizeStoredField(raw: unknown): UploadedLeaseField | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const key = typeof f.key === "string" ? f.key : "";
  if (!FIELD_KEYS.has(key)) return null;
  const status = (FIELD_STATUSES.has(String(f.status)) ? f.status : "not_found") as UploadedLeaseFieldStatus;
  const candidates = Array.isArray(f.candidates)
    ? f.candidates.map(normalizeCandidate).filter((c): c is UploadedLeaseFieldCandidate => c !== null).slice(0, 6)
    : [];
  return {
    key: key as UploadedLeaseFieldKey,
    label: FIELD_LABELS.get(key) ?? key,
    mapsTo: FIELD_MAPS_TO.get(key) ?? null,
    status,
    value: status === "extracted" ? coerceText(f.value).trim() : "",
    normalized: typeof f.normalized === "string" ? f.normalized : null,
    source: status === "extracted" ? normalizeSourceRef(f.source) : null,
    candidates: status === "ambiguous" ? candidates : [],
  };
}

/**
 * The blank-and-flagged row for a term the stored blob does not carry.
 *
 * An ABSENT row reads as "this term does not apply to this lease"; a blank
 * `not_found` row reads as "nobody found this, go check". Only the second is
 * true of a reading that simply lost the row, so every canonical term is always
 * present in the table.
 */
function blankNotFoundField(matcher: Pick<FieldMatcher, "key" | "label" | "mapsTo">): UploadedLeaseField {
  return {
    key: matcher.key,
    label: matcher.label,
    mapsTo: matcher.mapsTo,
    status: "not_found",
    value: "",
    normalized: null,
    source: null,
    candidates: [],
  };
}

function normalizeStoredSection(raw: unknown, index: number): UploadedLeaseSection | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  return {
    index,
    title: coerceText(s.title),
    body: coerceText(s.body),
    page: coercePage(s.page),
    charStart: coerceOffset(s.charStart),
    charEnd: coerceOffset(s.charEnd),
  };
}

/**
 * Coerce a parse blob arriving from storage.
 *
 * Absent means absent: `null`/`undefined` returns null, so a lease that never
 * had a parse keeps behaving exactly as it always did. Anything else PRESENT
 * but unreadable — not an object, a version this build does not know, sections
 * or fields that cannot be coerced — degrades to a `failed`, unconfirmed parse
 * rather than to null. That direction matters: null would silently unblock
 * signing, and the whole point of this record is to hold the lease until a
 * person has read the document. The manager can still confirm after reading the
 * original PDF, so failing closed is not a dead end.
 */
export function normalizeUploadedLeaseParse(raw: unknown): UploadedLeaseParse | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return failedUploadedLeaseParse("Uploaded lease.pdf", UNREADABLE_PARSE_REASON);
  const r = raw as Partial<UploadedLeaseParse> & Record<string, unknown>;
  const sourceFileName = String(r.sourceFileName ?? "").trim() || "Uploaded lease.pdf";
  if (r.version !== UPLOADED_LEASE_PARSE_VERSION) {
    return failedUploadedLeaseParse(sourceFileName, unreadableVersionReason(r.version));
  }
  const status = r.status === "parsed" || r.status === "failed" ? r.status : "pending";
  const reviewRaw = (r.review ?? {}) as Partial<UploadedLeaseReview>;
  const overridesRaw = (reviewRaw.overrides ?? {}) as Record<string, unknown>;
  const overrides: Partial<Record<UploadedLeaseFieldKey, string>> = {};
  for (const [key, value] of Object.entries(overridesRaw)) {
    if (FIELD_KEYS.has(key) && typeof value === "string" && value.trim()) {
      overrides[key as UploadedLeaseFieldKey] = value.trim();
    }
  }
  const sections = Array.isArray(r.sections)
    ? r.sections
        .map((s, i) => normalizeStoredSection(s, i))
        .filter((s): s is UploadedLeaseSection => s !== null)
        .map((s, i) => ({ ...s, index: i }))
    : [];
  const storedFields = new Map<UploadedLeaseFieldKey, UploadedLeaseField>();
  if (Array.isArray(r.fields)) {
    for (const rawField of r.fields) {
      const field = normalizeStoredField(rawField);
      if (field && !storedFields.has(field.key)) storedFields.set(field.key, field);
    }
  }
  const fields = FIELD_MATCHERS.map((matcher) => storedFields.get(matcher.key) ?? blankNotFoundField(matcher));
  return {
    version: UPLOADED_LEASE_PARSE_VERSION,
    status,
    sourceFileName,
    sourceSha256: typeof r.sourceSha256 === "string" && /^[0-9a-f]{64}$/.test(r.sourceSha256) ? r.sourceSha256 : null,
    pageCount: Number.isFinite(r.pageCount) ? Number(r.pageCount) : 0,
    characterCount: Number.isFinite(r.characterCount) ? Number(r.characterCount) : 0,
    extractedAtIso: typeof r.extractedAtIso === "string" ? r.extractedAtIso : null,
    sections,
    fields,
    failureReason: typeof r.failureReason === "string" ? r.failureReason : null,
    sourceIssues: Array.isArray(r.sourceIssues)
      ? r.sourceIssues.flatMap((rawIssue) => {
          if (!rawIssue || typeof rawIssue !== "object") return [];
          const issue = rawIssue as Record<string, unknown>;
          if (
            !(issue.pageNumber === null || Number.isInteger(issue.pageNumber)) ||
            typeof issue.code !== "string" ||
            typeof issue.message !== "string"
          ) return [];
          return [{
            pageNumber: issue.pageNumber as number | null,
            code: issue.code.slice(0, 80),
            message: issue.message.slice(0, 500),
          }];
        })
      : undefined,
    sourceCoverage:
      r.sourceCoverage && typeof r.sourceCoverage === "object"
        ? {
            extractedCharacters: Number.isFinite(r.sourceCoverage.extractedCharacters)
              ? Math.max(0, Number(r.sourceCoverage.extractedCharacters))
              : 0,
            representedCharacters: Number.isFinite(r.sourceCoverage.representedCharacters)
              ? Math.max(0, Number(r.sourceCoverage.representedCharacters))
              : 0,
            complete: r.sourceCoverage.complete === true,
          }
        : undefined,
    review: {
      status: reviewRaw.status === "confirmed" ? "confirmed" : "needs_review",
      confirmedByUserId: typeof reviewRaw.confirmedByUserId === "string" ? reviewRaw.confirmedByUserId : null,
      confirmedByName: typeof reviewRaw.confirmedByName === "string" ? reviewRaw.confirmedByName : null,
      confirmedAtIso: typeof reviewRaw.confirmedAtIso === "string" ? reviewRaw.confirmedAtIso : null,
      confirmedDocumentSha256:
        typeof reviewRaw.confirmedDocumentSha256 === "string" && /^[0-9a-f]{64}$/.test(reviewRaw.confirmedDocumentSha256)
          ? reviewRaw.confirmedDocumentSha256
          : null,
      confirmedConvertedHtmlSha256:
        typeof reviewRaw.confirmedConvertedHtmlSha256 === "string" && /^[0-9a-f]{64}$/.test(reviewRaw.confirmedConvertedHtmlSha256)
          ? reviewRaw.confirmedConvertedHtmlSha256
          : null,
      resolvedSourceIssueCodes: Array.isArray(reviewRaw.resolvedSourceIssueCodes)
        ? [...new Set(reviewRaw.resolvedSourceIssueCodes.filter((code) => typeof code === "string").map((code) => code.slice(0, 80)))].slice(0, 120)
        : [],
      confirmedRecordFingerprint:
        typeof reviewRaw.confirmedRecordFingerprint === "string" && reviewRaw.confirmedRecordFingerprint.trim()
          ? reviewRaw.confirmedRecordFingerprint
          : null,
      overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
      note: typeof reviewRaw.note === "string" ? reviewRaw.note : null,
    },
  };
}
