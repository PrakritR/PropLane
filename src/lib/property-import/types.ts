/**
 * Property import — what PropLane understood from a manager's spreadsheet.
 *
 * A manager uploads any .xlsx / .csv / .pdf (a rent roll, an owner's own
 * sheet, an AppFolio or Buildium export). The file is read into plain cell
 * grids (`read-file.server.ts`), the model reads the WHOLE thing and answers
 * in this shape (`understand.server.ts`), and each property becomes an
 * ordinary listing draft through `to-submission.ts`. Nothing here is a
 * second store: the drafts are the record.
 *
 * Isomorphic — the workspace renders these types in the browser.
 */

export const PROPERTY_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
/** Rows across every sheet that reach the model; past this the reader says which sheet was cut. */
export const PROPERTY_IMPORT_MAX_ROWS = 2000;
export const PROPERTY_IMPORT_MAX_PROPERTIES = 60;

export type PropertyImportSourceKind = "csv" | "xlsx" | "pdf";

export const PROPERTY_IMPORT_PROPERTY_TYPES = ["house", "townhouse", "apartment", "condo", "duplex", "other"] as const;
export type PropertyImportPropertyType = (typeof PROPERTY_IMPORT_PROPERTY_TYPES)[number];

/** One room or unit the file listed under a property. */
export type PropertyImportRoom = {
  /** "Room A", "Unit 2B", "Master bedroom" — the file's own name, tidied. */
  label: string;
  /** Monthly rent in whole dollars, or null when the file has none for this row. */
  rent: number | null;
  /** Security deposit in whole dollars, or null. */
  deposit: number | null;
  /** 1-based row number in the sheet this came from, for the "row 3" mark. */
  sourceRow: number | null;
};

export type PropertyImportProperty = {
  /** Stable within one read — the switcher and the Found list key on it. */
  key: string;
  /** What the manager would call it: "Maple Court" or the street address. */
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  propertyType: PropertyImportPropertyType;
  /** True when the file prices rooms separately (a shared home let by the room). */
  rentByRoom: boolean;
  bedrooms: number;
  bathrooms: number | null;
  /** Whole-place monthly rent when `rentByRoom` is false; null when unknown. */
  monthlyRent: number | null;
  /** Whole-place deposit when `rentByRoom` is false; null when unknown. */
  deposit: number | null;
  rooms: PropertyImportRoom[];
  /** Sheet name this property was read from. */
  sourceSheet: string;
  /** 1-based rows in that sheet, for "rows 3–6". */
  sourceRows: number[];
  /** Plain-English things the manager should look at ("room C has no rent"). */
  needsLook: string[];
  confidence: "high" | "medium" | "low";
};

export type PropertyImportSheetNote = {
  name: string;
  /** "One row per room, grouped by the Address column" / "Totals only — skipped". */
  whatItIs: string;
  used: boolean;
};

export type PropertyImportUnderstanding = {
  fileName: string;
  sourceKind: PropertyImportSourceKind;
  sheets: PropertyImportSheetNote[];
  properties: PropertyImportProperty[];
  /** Short bullets for "What PropLane understood". */
  summary: string[];
  /** Set when the reader cut rows to fit the cap — names the sheet. */
  truncatedNote: string | null;
  /** Rows the reader handed the model, across every sheet. */
  rowsRead: number;
};

/** What the read route returns. */
export type PropertyImportReadResponse =
  | { ok: true; understanding: PropertyImportUnderstanding }
  | { ok: false; error: string; code: "unreadable" | "empty" | "too_large" | "unsupported" | "unavailable" };
