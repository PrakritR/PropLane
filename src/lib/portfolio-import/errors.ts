/**
 * Portfolio import — reader-side errors.
 *
 * Kept out of `types.ts` (the shared draft contract) because these are thrown,
 * not part of the draft shape every entry point passes around. Both the
 * spreadsheet readers and the PDF rent-roll reader throw these; the routes turn
 * them into the wizard's error panel.
 */

import { PORTFOLIO_IMPORT_MAX_ROWS } from "@/lib/portfolio-import/types";

/** A file has more data rows than the hard cap allows. */
export class PortfolioImportRowLimitError extends Error {
  readonly rowCount: number;
  /** Alias of `rowCount`, kept for the PDF reader's call sites. */
  readonly count: number;

  constructor(rowCount: number) {
    super(
      `This file has ${rowCount} rows, over the ${PORTFOLIO_IMPORT_MAX_ROWS}-row import limit. Split it and import in parts.`,
    );
    this.name = "PortfolioImportRowLimitError";
    this.rowCount = rowCount;
    this.count = rowCount;
  }
}

/** The file could not be parsed at all — wrong format, corrupt, empty, or a photo scan. */
export class PortfolioImportUnreadableError extends Error {
  constructor(message = "We couldn't read that file.") {
    super(message);
    this.name = "PortfolioImportUnreadableError";
  }
}
