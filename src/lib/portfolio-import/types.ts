/**
 * Portfolio import — the ONE draft model every entry point shares.
 *
 * A manager switching from AppFolio, Buildium or a spreadsheet uploads a file
 * (csv / xlsx / rent-roll pdf) from the Properties tab, the dashboard import
 * icon, or as an Ask PropLane attachment. Every path produces a
 * `PortfolioImportDraft`, the review screen and the assistant's tools read the
 * same draft, and `commit.server.ts` turns it into real records. Nothing in
 * this file touches the database; it is the contract the wizard, the parser,
 * the commit and the agent tools all import.
 *
 * Invariants (docs/agents/portfolio-import.md):
 *  - numbers and counts come from the draft, never from a model;
 *  - a `block` issue stops the commit, a `review` issue never does;
 *  - every row keeps its source reference (sheet row or pdf page) so the
 *    manager can find it in the original file.
 */

export type PortfolioImportSourceKind = "csv" | "xlsx" | "pdf";

/** Which product the file looks like it came from; drives header presets. */
export type PortfolioImportSourcePreset = "appfolio" | "buildium" | "generic" | "pdf";

/** Canonical columns a rent roll can map onto. Anything else is kept as a note. */
export const PORTFOLIO_IMPORT_CANONICAL_KEYS = [
  "propertyName",
  "address",
  "city",
  "state",
  "zip",
  "unitLabel",
  "beds",
  "baths",
  "sqft",
  "residentName",
  "residentEmail",
  "residentPhone",
  "monthlyRent",
  "securityDeposit",
  "leaseStart",
  "leaseEnd",
  "moveIn",
  "moveOut",
  "occupancyStatus",
  "balance",
  "notes",
] as const;

export type PortfolioImportCanonicalKey = (typeof PORTFOLIO_IMPORT_CANONICAL_KEYS)[number];

export type PortfolioImportMatchConfidence = "exact" | "synonym" | "ai" | "manual" | "unmapped";

export type PortfolioImportColumnMapping = {
  /** Header text exactly as it appears in the file. */
  header: string;
  /** Zero-based column index in the source sheet. */
  index: number;
  /** Canonical key, or null when the column is kept only as a note. */
  key: PortfolioImportCanonicalKey | null;
  confidence: PortfolioImportMatchConfidence;
  /** Up to three sample cells, for the Match columns step. */
  samples: string[];
};

/** Where a value came from — a sheet row or a pdf page — so review can point at it. */
export type PortfolioImportSourceRef = {
  /** 1-based row in the sheet, or 1-based page in the pdf. */
  row: number;
  sheet?: string;
  page?: number;
};

export type PortfolioImportIssueSeverity = "block" | "review" | "info";

export type PortfolioImportIssueCode =
  | "missing_email"
  | "missing_phone"
  | "invalid_email"
  | "invalid_phone"
  | "duplicate_resident"
  | "shared_unit"
  | "past_due_balance"
  | "vacant_unit"
  | "summary_row_skipped"
  | "missing_rent"
  | "missing_property"
  | "missing_unit"
  | "pdf_verify"
  | "unmapped_column"
  | "row_limit";

export type PortfolioImportIssue = {
  id: string;
  code: PortfolioImportIssueCode;
  severity: PortfolioImportIssueSeverity;
  /** One sentence for the manager, no internal terms. */
  message: string;
  /** Optional second sentence: what happens if they continue. */
  detail?: string;
  propertyKey?: string;
  unitKey?: string;
  residentKey?: string;
  source?: PortfolioImportSourceRef;
  /** True once the manager resolved or acknowledged it on the review screen. */
  resolved?: boolean;
};

export type PortfolioImportProperty = {
  /** Stable key within the draft (slug of the address). */
  key: string;
  name: string;
  address: string;
  city?: string;
  state?: string;
  zip?: string;
  /** Sum of unit beds/baths when the file has them, otherwise 0. */
  beds: number;
  baths: number;
  /** "unit" when the file labels look like apartments (1A, 2B), "room" for rooms. */
  inventoryKind: "unit" | "room";
  unitKeys: string[];
  excluded?: boolean;
  source: PortfolioImportSourceRef;
};

export type PortfolioImportUnit = {
  key: string;
  propertyKey: string;
  label: string;
  monthlyRent: number | null;
  securityDeposit: number | null;
  beds?: number;
  baths?: number;
  sqft?: number;
  occupancy: "occupied" | "vacant" | "unknown";
  residentKeys: string[];
  excluded?: boolean;
  source: PortfolioImportSourceRef;
};

export type PortfolioImportResident = {
  key: string;
  propertyKey: string;
  unitKey: string;
  name: string;
  email: string | null;
  /** E.164 when it parsed, otherwise null (the raw value stays in `notes`). */
  phone: string | null;
  leaseStart: string | null;
  leaseEnd: string | null;
  moveIn: string | null;
  monthlyRent: number | null;
  securityDeposit: number | null;
  /** Past-due balance in dollars, when the file has a balance column. */
  balance: number | null;
  /** Attached on the review screen through the existing lease-pdf parser. */
  leasePdf?: {
    fileName: string;
    dataUrl: string;
    fullyExecuted: boolean;
  } | null;
  notes?: string;
  excluded?: boolean;
  /** Which welcome channels this resident can receive, given what the file had. */
  inviteChannels: { email: boolean; text: boolean };
  source: PortfolioImportSourceRef;
};

export type PortfolioImportBalance = {
  key: string;
  residentKey: string;
  amount: number;
  /** Manager can untick on the review screen; default true. */
  create: boolean;
};

export type PortfolioImportPlannedTaskKind =
  | "add_photos"
  | "upload_signed_lease"
  | "lease_ending"
  | "add_resident_email"
  | "verify_imported_data"
  | "connect_payouts";

export type PortfolioImportPlannedTask = {
  key: string;
  kind: PortfolioImportPlannedTaskKind;
  title: string;
  notes?: string;
  propertyKey?: string;
  unitKey?: string;
  residentKey?: string;
  /** YYYY-MM-DD */
  dueDate: string;
  taskType: "general" | "house";
  urgency: "scheduled" | "urgent" | "deadline";
};

export type PortfolioImportDraft = {
  version: 1;
  sourceKind: PortfolioImportSourceKind;
  preset: PortfolioImportSourcePreset;
  fileName: string;
  /** Rows read from the file before grouping (summary rows already dropped). */
  rowCount: number;
  columns: PortfolioImportColumnMapping[];
  properties: PortfolioImportProperty[];
  units: PortfolioImportUnit[];
  residents: PortfolioImportResident[];
  balances: PortfolioImportBalance[];
  tasks: PortfolioImportPlannedTask[];
  issues: PortfolioImportIssue[];
  /** Header-only AI mapping ran (never row data). */
  aiMappedHeaders: boolean;
};

export type PortfolioImportStatus =
  | "uploaded"
  | "draft"
  | "committing"
  | "completed"
  | "failed"
  | "discarded";

export type PortfolioImportRecordKind = "property" | "room" | "resident" | "balance" | "task";

/** One receipt per planned record; `manager_portfolio_import_records`. */
export type PortfolioImportRecordReceipt = {
  recordKind: PortfolioImportRecordKind;
  sourceKey: string;
  payloadHash: string;
  status: "prepared" | "completed";
  canonicalId: string | null;
};

export type PortfolioImportStageProgress = {
  stage: PortfolioImportRecordKind;
  done: number;
  total: number;
  failed: number;
};

export type PortfolioImportCommitResult = {
  status: "completed" | "partial" | "failed";
  progress: PortfolioImportStageProgress[];
  /** Property record ids created, in draft order. */
  propertyIds: string[];
  /** Application (resident) ids created, in draft order. */
  residentApplicationIds: string[];
  taskIds: string[];
  balanceChargeIds: string[];
  failures: Array<{
    recordKind: PortfolioImportRecordKind;
    sourceKey: string;
    message: string;
  }>;
};

export type PortfolioImportInviteChannel = "email" | "text" | "both";

export type PortfolioImportInviteResult = {
  residentKey: string;
  applicationId: string | null;
  email: "sent" | "skipped_no_email" | "already_sent" | "failed" | "not_requested";
  text: "sent" | "skipped_no_phone" | "skipped_no_work_number" | "already_sent" | "failed" | "not_requested";
  error?: string;
};

/** Summary the assistant tools and the wizard header both show. Counts only. */
export type PortfolioImportSummary = {
  importId: string;
  status: PortfolioImportStatus;
  fileName: string;
  sourceKind: PortfolioImportSourceKind;
  preset: PortfolioImportSourcePreset;
  propertyCount: number;
  unitCount: number;
  residentCount: number;
  balanceCount: number;
  balanceTotal: number;
  taskCount: number;
  blockingIssueCount: number;
  reviewIssueCount: number;
  invitableByEmail: number;
  invitableByText: number;
  createdAt: string;
  committedAt: string | null;
};

/**
 * What every reader (csv, xlsx, pdf) hands to `build-draft.ts`: a header row
 * and cells as strings, each row tagged with where it came from. Readers never
 * interpret values; grouping and parsing money/dates happen once, in build-draft.
 */
export type PortfolioImportSourceTable = {
  sheet?: string;
  headers: string[];
  rows: Array<{ cells: string[]; source: PortfolioImportSourceRef }>;
  /** Rows the reader dropped (blank, "Total"), reported as info issues. */
  skippedRows: PortfolioImportSourceRef[];
};

/** Hard caps, enforced server-side before any parsing. */
export const PORTFOLIO_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const PORTFOLIO_IMPORT_MAX_ROWS = 2000;
