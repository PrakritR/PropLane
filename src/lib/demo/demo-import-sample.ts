import type { PortfolioImportProposal } from "@/lib/portfolio-import/types";

/**
 * A bundled, deterministic sample rent roll for the `/demo` sandbox's
 * Properties → Import review screen (captain 2026-09-25, home page
 * "Switching" section: a scaled iframe of this real screen, not a hand-drawn
 * replica). Never read from a file, never touches
 * `manager_portfolio_import*` or any other real table — this is the exact
 * shape `PortfolioImportReviewStep` renders after a real upload, authored by
 * hand so `/demo` needs no network read to show it.
 *
 * Same story the section's copy always told (before this file existed, a
 * hard-coded HTML replica carried these same names/rents/dates): Maple
 * Court's Dana Reyes is ready, Luis Ortega is missing his lease end date,
 * one Maple room sits vacant; 1412 Pine St's Sam Chen and Jordan Wu are both
 * ready, one Pine room sits vacant. 7 rooms, 4 residents, 1 open item.
 */
export const DEMO_IMPORT_SAMPLE: PortfolioImportProposal = {
  importId: "demo-import-sample",
  files: [{ name: "rent-roll.xlsx", kind: "spreadsheet" }],
  properties: [
    {
      key: "demo-import-maple-court",
      address: "220 Maple Ave",
      status: "ready",
      source: { file: "rent-roll.xlsx", sheet: "Maple Court", rows: [2, 6] },
      rooms: [
        { key: "demo-import-maple-1", name: "Room 1", rent: 1850, source: { file: "rent-roll.xlsx", sheet: "Maple Court", rows: [4] } },
        { key: "demo-import-maple-2", name: "Room 2", rent: 1400, source: { file: "rent-roll.xlsx", sheet: "Maple Court", rows: [5] } },
        { key: "demo-import-maple-3", name: "Room 3", rent: 1400, source: { file: "rent-roll.xlsx", sheet: "Maple Court", rows: [6] } },
        { key: "demo-import-maple-4", name: "Room 4", rent: null, source: { file: "rent-roll.xlsx", sheet: "Maple Court", rows: [7] } },
      ],
      residents: [
        {
          key: "demo-import-dana-reyes",
          roomKey: "demo-import-maple-1",
          name: "Dana Reyes",
          email: "dana.reyes@example.com",
          phone: "206-555-0114",
          leaseStart: "2025-03-01",
          leaseEnd: "2026-02-28",
          rent: 1850,
          deposit: 1850,
          balance: 0,
          status: "ready",
          gaps: [],
          source: { file: "rent-roll.xlsx", sheet: "Maple Court", rows: [4] },
        },
        {
          key: "demo-import-luis-ortega",
          roomKey: "demo-import-maple-3",
          name: "Luis Ortega",
          email: "luis.ortega@example.com",
          phone: null,
          leaseStart: "2025-06-01",
          leaseEnd: null,
          rent: 1400,
          deposit: 1400,
          balance: 0,
          status: "needs",
          gaps: [{ field: "leaseEnd", question: "When does the lease end?" }],
          source: { file: "rent-roll.xlsx", sheet: "Maple Court", rows: [6] },
        },
      ],
      charges: [
        {
          key: "demo-import-dana-rent",
          residentKey: "demo-import-dana-reyes",
          kind: "rent",
          amount: 1850,
          dueDate: "2026-10-01",
          label: "October rent",
          source: { file: "rent-roll.xlsx", sheet: "Maple Court", rows: [4] },
        },
        {
          key: "demo-import-luis-rent",
          residentKey: "demo-import-luis-ortega",
          kind: "rent",
          amount: 1400,
          dueDate: "2026-10-01",
          label: "October rent",
          source: { file: "rent-roll.xlsx", sheet: "Maple Court", rows: [6] },
        },
      ],
      tasks: [
        {
          key: "demo-import-luis-end-date",
          residentKey: "demo-import-luis-ortega",
          title: "Confirm Luis Ortega's lease end date",
          kind: "missing_end_date",
          source: { file: "rent-roll.xlsx", sheet: "Maple Court", rows: [6] },
        },
      ],
    },
    {
      key: "demo-import-pine-st",
      address: "1412 Pine St",
      status: "ready",
      source: { file: "rent-roll.xlsx", sheet: "Pine St", rows: [10, 13] },
      rooms: [
        { key: "demo-import-pine-1", name: "Room 1", rent: 1100, source: { file: "rent-roll.xlsx", sheet: "Pine St", rows: [11] } },
        { key: "demo-import-pine-2", name: "Room 2", rent: 1050, source: { file: "rent-roll.xlsx", sheet: "Pine St", rows: [12] } },
        { key: "demo-import-pine-3", name: "Room 3", rent: null, source: { file: "rent-roll.xlsx", sheet: "Pine St", rows: [13] } },
      ],
      residents: [
        {
          key: "demo-import-sam-chen",
          roomKey: "demo-import-pine-1",
          name: "Sam Chen",
          email: "sam.chen@example.com",
          phone: "206-555-0148",
          leaseStart: "2025-01-01",
          leaseEnd: "2025-12-31",
          rent: 1100,
          deposit: 1100,
          balance: 0,
          status: "ready",
          gaps: [],
          source: { file: "rent-roll.xlsx", sheet: "Pine St", rows: [11] },
        },
        {
          key: "demo-import-jordan-wu",
          roomKey: "demo-import-pine-2",
          name: "Jordan Wu",
          email: "jordan.wu@example.com",
          phone: "206-555-0177",
          leaseStart: "2025-02-01",
          leaseEnd: "2026-01-31",
          rent: 1050,
          deposit: 1050,
          balance: 0,
          status: "ready",
          gaps: [],
          source: { file: "rent-roll.xlsx", sheet: "Pine St", rows: [12] },
        },
      ],
      charges: [
        {
          key: "demo-import-sam-rent",
          residentKey: "demo-import-sam-chen",
          kind: "rent",
          amount: 1100,
          dueDate: "2026-10-01",
          label: "October rent",
          source: { file: "rent-roll.xlsx", sheet: "Pine St", rows: [11] },
        },
        {
          key: "demo-import-jordan-rent",
          residentKey: "demo-import-jordan-wu",
          kind: "rent",
          amount: 1050,
          dueDate: "2026-10-01",
          label: "October rent",
          source: { file: "rent-roll.xlsx", sheet: "Pine St", rows: [12] },
        },
      ],
      tasks: [],
    },
  ],
  summary: {
    properties: 2,
    rooms: 7,
    residents: 4,
    charges: 4,
    tasks: 1,
    gaps: 1,
  },
};
