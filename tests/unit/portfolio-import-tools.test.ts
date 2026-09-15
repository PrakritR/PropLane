/**
 * The portfolio-import agent tools (`src/lib/tools/domains/portfolio-import.ts`):
 * previews copy every count straight from the stored draft summary, commit
 * refuses on unresolved blocking issues, invite explains an email-only send
 * when there is no work number, the tools live on the manager registry only,
 * and every lookup is scoped to the calling landlord.
 *
 * `store.server.ts` and `invite.server.ts` are mocked so these tests exercise
 * the TOOL's own logic (scoping, preview copy, error messages) rather than
 * the database layer or SMS/email delivery, which have their own suites
 * (portfolio-import-commit.test.ts, portfolio-import-invite.test.ts).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentContext } from "@/lib/tools/context";
import type { PortfolioImportRow } from "@/lib/portfolio-import/store.server";
import type {
  PortfolioImportDraft,
  PortfolioImportStatus,
  PortfolioImportSummary,
} from "@/lib/portfolio-import/types";

const loadPortfolioImportMock = vi.fn();
const listPortfolioImportsMock = vi.fn();
const summaryForMock = vi.fn();

vi.mock("@/lib/portfolio-import/store.server", () => ({
  loadPortfolioImport: (...args: unknown[]) => loadPortfolioImportMock(...args),
  listPortfolioImports: (...args: unknown[]) => listPortfolioImportsMock(...args),
  summaryFor: (...args: unknown[]) => summaryForMock(...args),
}));

const portfolioImportMessagingStatusMock = vi.fn();
const invitePortfolioImportResidentsMock = vi.fn();

vi.mock("@/lib/portfolio-import/invite.server", () => ({
  portfolioImportMessagingStatus: (...args: unknown[]) => portfolioImportMessagingStatusMock(...args),
  invitePortfolioImportResidents: (...args: unknown[]) => invitePortfolioImportResidentsMock(...args),
}));

const commitPortfolioImportMock = vi.fn();

vi.mock("@/lib/portfolio-import/commit.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/portfolio-import/commit.server")>(
    "@/lib/portfolio-import/commit.server",
  );
  return {
    ...actual,
    commitPortfolioImport: (...args: unknown[]) => commitPortfolioImportMock(...args),
  };
});

const {
  listPortfolioImportsTool,
  getPortfolioImportTool,
  commitPortfolioImportTool,
  inviteImportedResidentsTool,
} = await import("@/lib/tools/domains/portfolio-import");
const { agentRegistry } = await import("@/lib/tools");
const { residentAgentRegistry } = await import("@/lib/tools/resident-index");
const { vendorAgentRegistry } = await import("@/lib/tools/vendor-index");

const MGR = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const IMPORT_ID = "44444444-4444-4444-8444-444444444444";

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    landlordId: MGR,
    userId: MGR,
    email: "manager@example.com",
    roles: ["manager"],
    isAdmin: false,
    db: {} as never,
    ...overrides,
  } as AgentContext;
}

function makeDraft(overrides: Partial<PortfolioImportDraft> = {}): PortfolioImportDraft {
  return {
    version: 1,
    sourceKind: "csv",
    preset: "generic",
    fileName: "rent-roll.csv",
    rowCount: 1,
    columns: [],
    properties: [
      {
        key: "p1",
        name: "Maple Court",
        address: "123 Maple St",
        beds: 2,
        baths: 1,
        inventoryKind: "unit",
        unitKeys: ["u1"],
        source: { row: 1 },
      },
    ],
    units: [
      {
        key: "u1",
        propertyKey: "p1",
        label: "1A",
        monthlyRent: 1500,
        securityDeposit: null,
        occupancy: "occupied",
        residentKeys: ["r1"],
        source: { row: 1 },
      },
    ],
    residents: [
      {
        key: "r1",
        propertyKey: "p1",
        unitKey: "u1",
        name: "Jane Doe",
        email: "jane@example.com",
        phone: "+15551234567",
        leaseStart: "2025-01-01",
        leaseEnd: null,
        moveIn: "2025-01-01",
        monthlyRent: 1500,
        securityDeposit: 1500,
        balance: 200,
        inviteChannels: { email: true, text: true },
        source: { row: 1 },
      },
    ],
    balances: [{ key: "b1", residentKey: "r1", amount: 200, create: true }],
    tasks: [{ key: "t1", kind: "verify_imported_data", title: "Verify imported data", dueDate: "2025-02-01", taskType: "general", urgency: "scheduled" }],
    issues: [],
    aiMappedHeaders: false,
    ...overrides,
  };
}

function makeSummary(draft: PortfolioImportDraft, status: PortfolioImportStatus): PortfolioImportSummary {
  return {
    importId: IMPORT_ID,
    status,
    fileName: draft.fileName,
    sourceKind: draft.sourceKind,
    preset: draft.preset,
    propertyCount: draft.properties.filter((p) => !p.excluded).length,
    unitCount: draft.units.length,
    residentCount: draft.residents.length,
    balanceCount: draft.balances.length,
    balanceTotal: draft.balances.reduce((sum, b) => sum + b.amount, 0),
    taskCount: draft.tasks.length,
    blockingIssueCount: draft.issues.filter((i) => i.severity === "block" && !i.resolved).length,
    reviewIssueCount: draft.issues.filter((i) => i.severity === "review" && !i.resolved).length,
    invitableByEmail: draft.residents.filter((r) => r.inviteChannels.email).length,
    invitableByText: draft.residents.filter((r) => r.inviteChannels.text).length,
    createdAt: "2025-01-01T00:00:00.000Z",
    committedAt: status === "completed" ? "2025-01-02T00:00:00.000Z" : null,
  };
}

/** Builds the row store.server would return AND wires summaryForMock for it. */
function makeRow(opts: {
  managerUserId?: string;
  status?: PortfolioImportStatus;
  draft?: PortfolioImportDraft | null;
}): { row: PortfolioImportRow; summary: PortfolioImportSummary | null } {
  const managerUserId = opts.managerUserId ?? MGR;
  const status = opts.status ?? "draft";
  const draft = opts.draft === undefined ? makeDraft() : opts.draft;
  const summary = draft ? makeSummary(draft, status) : null;
  const row: PortfolioImportRow = {
    id: IMPORT_ID,
    manager_user_id: managerUserId,
    source_kind: draft?.sourceKind ?? "csv",
    preset: draft?.preset ?? "generic",
    file_name: draft?.fileName ?? "rent-roll.csv",
    file_sha256: "a".repeat(64),
    status,
    draft: draft ? { version: 1, table: { headers: [], rows: [], skippedRows: [] }, draft } : null,
    result: null,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    committed_at: status === "completed" ? "2025-01-02T00:00:00.000Z" : null,
  };
  return { row, summary };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("registry membership", () => {
  it("registers all four tools on the manager registry", () => {
    for (const name of [
      "list_portfolio_imports",
      "get_portfolio_import",
      "commit_portfolio_import",
      "invite_imported_residents",
    ]) {
      expect(agentRegistry.has(name)).toBe(true);
    }
  });

  it("never appears on the resident or vendor registries", () => {
    for (const name of [
      "list_portfolio_imports",
      "get_portfolio_import",
      "commit_portfolio_import",
      "invite_imported_residents",
    ]) {
      expect(residentAgentRegistry.has(name)).toBe(false);
      expect(vendorAgentRegistry.has(name)).toBe(false);
    }
  });
});

describe("list_portfolio_imports", () => {
  it("returns the manager's imports via summaryFor", async () => {
    const { row, summary } = makeRow({});
    listPortfolioImportsMock.mockResolvedValue([row]);
    summaryForMock.mockReturnValue(summary);

    const result = (await listPortfolioImportsTool.handler(makeCtx(), {})) as { count: number; imports: unknown[] };
    expect(listPortfolioImportsMock).toHaveBeenCalledWith(expect.anything(), MGR);
    expect(result.count).toBe(1);
    expect(result.imports).toEqual([summary]);
  });
});

describe("get_portfolio_import — landlord scoping", () => {
  it("throws for an importId that does not belong to this landlord", async () => {
    // store.server's own manager_user_id filter would return null for a
    // foreign id; simulate that contract directly.
    loadPortfolioImportMock.mockImplementation(async (_db: unknown, managerUserId: string) =>
      managerUserId === MGR ? makeRow({}).row : null,
    );

    await expect(getPortfolioImportTool.handler(makeCtx({ landlordId: OTHER }), { importId: IMPORT_ID })).rejects.toThrow(
      /does not belong to this landlord|No import with that id/i,
    );
    expect(loadPortfolioImportMock).toHaveBeenCalledWith(expect.anything(), OTHER, IMPORT_ID);
  });

  it("returns issues (unresolved, block first), properties, residents, and messaging for an owned import", async () => {
    const draft = makeDraft({
      issues: [
        { id: "i-review", code: "missing_phone", severity: "review", message: "No phone on file", resolved: false },
        { id: "i-block", code: "missing_email", severity: "block", message: "Missing email for Jane Doe", resolved: false },
        { id: "i-resolved", code: "vacant_unit", severity: "review", message: "Resolved already", resolved: true },
      ],
    });
    const { row, summary } = makeRow({ draft });
    loadPortfolioImportMock.mockResolvedValue(row);
    summaryForMock.mockReturnValue(summary);
    portfolioImportMessagingStatusMock.mockResolvedValue({ workNumber: null, canText: false, settingsHref: "/settings/messaging" });

    const result = (await getPortfolioImportTool.handler(makeCtx(), { importId: IMPORT_ID })) as {
      summary: PortfolioImportSummary;
      issues: { id: string; severity: string }[];
      properties: { name: string; unitCount: number }[];
      residents: { name: string; home: string | null }[];
      messaging: { workNumber: string | null };
    };

    expect(result.summary).toEqual(summary);
    expect(result.issues.map((i) => i.id)).toEqual(["i-block", "i-review"]);
    expect(result.properties).toEqual([{ name: "Maple Court", address: "123 Maple St", unitCount: 1 }]);
    expect(result.residents[0]?.name).toBe("Jane Doe");
    expect(result.residents[0]?.home).toBe("Maple Court · 1A");
    expect(result.messaging.workNumber).toBeNull();
  });
});

describe("commit_portfolio_import preview", () => {
  it("copies every number straight from the summary", async () => {
    const draft = makeDraft();
    const { row, summary } = makeRow({ draft });
    loadPortfolioImportMock.mockResolvedValue(row);
    summaryForMock.mockReturnValue(summary);

    const preview = await commitPortfolioImportTool.preview(makeCtx(), { importId: IMPORT_ID });

    expect(preview.title).toContain(draft.fileName);
    expect(preview.summary).toContain(`${summary.propertyCount} properties`);
    expect(preview.summary).toContain(`${summary.unitCount} units`);
    expect(preview.summary).toContain(`${summary.residentCount} residents`);
    expect(preview.summary).toContain(`${summary.taskCount} tasks`);
    expect(preview.summary).toContain(`$${summary.balanceTotal.toFixed(2)}`);
    expect(preview.fields).toEqual(
      expect.arrayContaining([
        { label: "Properties", value: expect.stringContaining(String(summary.propertyCount)) },
        { label: "Units / rooms", value: `${summary.unitCount}` },
        { label: "Residents", value: `${summary.residentCount}` },
        { label: "Tasks", value: `${summary.taskCount}` },
      ]),
    );
    expect(preview.confirmLabel).toBe("Import");
  });

  it("throws naming the first three blocking issues when the draft has unresolved block issues", async () => {
    const draft = makeDraft({
      issues: [
        { id: "i1", code: "missing_email", severity: "block", message: "Resident A has no email", resolved: false },
        { id: "i2", code: "missing_property", severity: "block", message: "Row 4 has no property", resolved: false },
        { id: "i3", code: "missing_rent", severity: "block", message: "Unit 2B has no rent", resolved: false },
        { id: "i4", code: "invalid_email", severity: "block", message: "Row 9 email looks wrong", resolved: false },
        { id: "i5", code: "missing_phone", severity: "review", message: "This one never blocks", resolved: false },
      ],
    });
    const { row, summary } = makeRow({ draft });
    loadPortfolioImportMock.mockResolvedValue(row);
    summaryForMock.mockReturnValue(summary);

    await expect(commitPortfolioImportTool.preview(makeCtx(), { importId: IMPORT_ID })).rejects.toThrow(
      /4 issues must be fixed on the review screen first: Resident A has no email; Row 4 has no property; Unit 2B has no rent/,
    );
  });

  it("refuses an import that was already committed", async () => {
    const { row } = makeRow({ status: "completed" });
    loadPortfolioImportMock.mockResolvedValue(row);

    await expect(commitPortfolioImportTool.preview(makeCtx(), { importId: IMPORT_ID })).rejects.toThrow(/already committed/i);
  });

  it("throws for a foreign importId", async () => {
    loadPortfolioImportMock.mockResolvedValue(null);
    await expect(commitPortfolioImportTool.preview(makeCtx({ landlordId: OTHER }), { importId: IMPORT_ID })).rejects.toThrow(
      /belongs to this landlord/i,
    );
  });
});

describe("invite_imported_residents preview", () => {
  it("is email-only and warns when there is no PropLane work number", async () => {
    const { row } = makeRow({ status: "completed" });
    loadPortfolioImportMock.mockResolvedValue(row);
    portfolioImportMessagingStatusMock.mockResolvedValue({ workNumber: null, canText: false, settingsHref: "/settings/messaging" });

    const preview = await inviteImportedResidentsTool.preview(makeCtx(), { importId: IMPORT_ID });

    expect(preview.warnings).toEqual(
      expect.arrayContaining(["Email only — text invites need a PropLane work number (Settings → Messaging)."]),
    );
    expect(preview.fields).toEqual(
      expect.arrayContaining([{ label: "Text", value: "None — no PropLane work number" }]),
    );
    // confirmedInput pins what the model asked for so the handler executes exactly what was shown.
    expect(preview.confirmedInput).toMatchObject({ importId: IMPORT_ID, channels: "email" });
  });

  it("lists both channels and the sending number when a work number exists", async () => {
    const { row } = makeRow({ status: "completed" });
    loadPortfolioImportMock.mockResolvedValue(row);
    portfolioImportMessagingStatusMock.mockResolvedValue({
      workNumber: "+15559876543",
      canText: true,
      settingsHref: "/settings/messaging",
    });

    const preview = await inviteImportedResidentsTool.preview(makeCtx(), { importId: IMPORT_ID });

    expect(preview.warnings ?? []).toEqual([]);
    const textField = preview.fields.find((f) => f.label === "Text");
    expect(textField?.value).toContain("+15559876543");
    expect(preview.confirmedInput).toMatchObject({ channels: "both" });
  });

  it("refuses to invite before the import has been committed", async () => {
    const { row } = makeRow({ status: "draft" });
    loadPortfolioImportMock.mockResolvedValue(row);

    await expect(inviteImportedResidentsTool.preview(makeCtx(), { importId: IMPORT_ID })).rejects.toThrow(/not been committed/i);
  });

  it("throws for a foreign importId", async () => {
    loadPortfolioImportMock.mockResolvedValue(null);
    await expect(
      inviteImportedResidentsTool.preview(makeCtx({ landlordId: OTHER }), { importId: IMPORT_ID }),
    ).rejects.toThrow(/belongs to this landlord/i);
  });
});
