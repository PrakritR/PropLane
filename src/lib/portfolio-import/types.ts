/**
 * Portfolio import (rebuilt) — the contract the review UI, the server
 * pipeline, and the agent status tool all share.
 *
 * A manager switching from AppFolio, Buildium, or a spreadsheet uploads
 * files at /portal/properties/import and gets ONE proposal back: properties
 * (as listing drafts, same as `src/lib/property-import/`), the CURRENT
 * residents living in each room today, the leases/charges/tasks that follow
 * from them. Two model passes read the same row-numbered grids
 * (`src/lib/property-import/read-file.server.ts`): the existing
 * `understandPropertyImport` for properties/rooms, and this module's
 * `understandResidents` for who lives where. Everything the manager sees
 * cites its file/sheet/rows (or pdf page) so it can be checked against the
 * source. Nothing here is a second store — the proposal is staged in
 * `manager_portfolio_import*` until the manager reviews and creates, and
 * creation writes through the SAME paths every other entry point uses
 * (listing drafts, add-resident, uploaded leases, household charges, tasks).
 *
 * Money is whole US dollars as numbers everywhere in this module, matching
 * `src/lib/property-import/types.ts` (`PropertyImportRoom.rent`) — the same
 * convention `to-submission.ts` already relies on. Where a persisted row
 * stores cents (household charges, `row_data` money fields elsewhere in the
 * app), the boundary that writes it is responsible for the dollars→cents
 * conversion; nothing in this file is stored in cents.
 *
 * Invariants (see docs/agents/portfolio-import.md, rebuilt):
 *  - rent is what the tenant PAYS, never market/asking rent, never a
 *    deposit or a balance;
 *  - every proposal item cites its file/sheet/rows or pdf page;
 *  - a "needs" item never gets created silently — the manager answers its
 *    gaps or it is skipped;
 *  - invites go out only when the manager opts in at create time.
 */

/** Where a proposed value came from in the source file, for "row 4" / "p2" citations. */
export type ImportSource = { file: string; sheet?: string; rows?: number[]; page?: number };

/** One thing the file did not have that the manager must answer before creating. */
export type ImportGap = { field: string; question: string };

export type ImportItemStatus = "ready" | "needs" | "skip";

export type ImportRoomProposal = {
  key: string;
  name: string;
  /** Monthly rent in whole dollars; null when the file had none for this room. */
  rent: number | null;
  source: ImportSource;
};

export type ImportResidentProposal = {
  key: string;
  /** Room this resident lives in, or null when the file did not tie them to a room. */
  roomKey: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  /** YYYY-MM-DD */
  leaseStart: string | null;
  /** YYYY-MM-DD */
  leaseEnd: string | null;
  /** Monthly rent this resident pays, in whole dollars — never market/asking rent. */
  rent: number | null;
  /** Security deposit held, in whole dollars. */
  deposit: number | null;
  /** Past-due balance, in whole dollars. */
  balance: number | null;
  status: ImportItemStatus;
  gaps: ImportGap[];
  source: ImportSource;
};

export type ImportChargeProposal = {
  key: string;
  residentKey: string;
  kind: "rent" | "deposit" | "balance";
  /** Whole dollars — converted to cents only at the point a real charge row is written. */
  amount: number;
  /** YYYY-MM-DD, or null when the file gave no due date. */
  dueDate: string | null;
  label: string;
  source: ImportSource;
};

export type ImportTaskKind = "missing_end_date" | "unsigned_lease" | "move_in_photos" | "missing_contact" | "other";

export type ImportTaskProposal = {
  key: string;
  residentKey: string | null;
  title: string;
  kind: ImportTaskKind;
  source: ImportSource;
};

export type ImportPropertyProposal = {
  key: string;
  address: string;
  source: ImportSource;
  rooms: ImportRoomProposal[];
  residents: ImportResidentProposal[];
  charges: ImportChargeProposal[];
  tasks: ImportTaskProposal[];
  status: ImportItemStatus;
};

export type PortfolioImportFileKind = "spreadsheet" | "appfolio" | "buildium" | "lease_pdf" | "rent_roll_pdf" | "unknown";

export type PortfolioImportProposalSummary = {
  properties: number;
  rooms: number;
  residents: number;
  charges: number;
  tasks: number;
  gaps: number;
};

export type PortfolioImportProposal = {
  importId: string;
  files: { name: string; kind: PortfolioImportFileKind }[];
  properties: ImportPropertyProposal[];
  summary: PortfolioImportProposalSummary;
};

/** Body of `PATCH /api/portal/portfolio-import/[importId]`. */
export type PortfolioImportUpdateRequest = {
  /** Keyed by resident (or property) key; merges into that item's proposed fields. */
  answers?: Record<string, Partial<ImportResidentProposal>>;
  /**
   * Resident, property, or (empty) room keys to mark "skip". A skipped room
   * is dropped from its property's `rooms` entirely — see
   * `applyAnswersAndSkips` in store.server.ts.
   */
  skips?: string[];
};

/** Body of `POST /api/portal/portfolio-import/[importId]/create`. */
export type PortfolioImportCreateRequest = {
  sendInvites: boolean;
  /** Keyed by resident (or property) key; merges into that item's proposed fields before create. */
  answers?: Record<string, Partial<ImportResidentProposal>>;
  /** Resident, property, or (empty) room keys to leave out of creation. */
  skips?: string[];
};

export type PortfolioImportCreateCounts = {
  properties: number;
  rooms: number;
  residents: number;
  leases: number;
  charges: number;
  tasks: number;
  invites: number;
};

export type PortfolioImportCreateFailure = {
  propertyKey: string;
  address: string;
  /** The source row the failure traces to, when known. */
  row?: number;
  message: string;
};

export type PortfolioImportCreateResult = {
  created: PortfolioImportCreateCounts;
  failures: PortfolioImportCreateFailure[];
};

/** Hard caps, enforced server-side before any parsing. */
export const PORTFOLIO_IMPORT_MAX_FILES = 50;
export const PORTFOLIO_IMPORT_MAX_BYTES_PER_FILE = 5 * 1024 * 1024;
export const PORTFOLIO_IMPORT_RATE_LIMIT_PER_MINUTE = 8;
