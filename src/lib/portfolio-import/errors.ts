/**
 * Shared portfolio-import errors. Both the spreadsheet readers and the PDF
 * rent-roll reader throw these — keep this file to exactly these two small
 * classes so a parallel add from another reader merges cleanly.
 */

export class PortfolioImportUnreadableError extends Error {
  constructor(message = "We couldn't read that file.") {
    super(message);
    this.name = "PortfolioImportUnreadableError";
  }
}

export class PortfolioImportRowLimitError extends Error {
  readonly count: number;

  constructor(count: number) {
    super(`This file has ${count} rows, more than PropLane can import at once.`);
    this.name = "PortfolioImportRowLimitError";
    this.count = count;
  }
}
