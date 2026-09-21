/**
 * portfolio_import_status — a manager-portal-only read tool. It answers
 * straight from the stored proposal (never recomputes), is scoped to
 * ctx.landlordId, and is withheld from the manager SMS registry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@/lib/tools/context";
import type { PortfolioImportProposal } from "@/lib/portfolio-import/types";

const { loadImportProposal } = vi.hoisted(() => ({ loadImportProposal: vi.fn() }));
vi.mock("@/lib/portfolio-import/store.server", () => ({ loadImportProposal }));

import { portfolioImportStatusTool } from "@/lib/tools/domains/portfolio-import";
import { agentRegistry, buildManagerSmsRegistry, MANAGER_PORTAL_ONLY_TOOLS } from "@/lib/tools";

function ctx(landlordId = "mgr-1"): AgentContext {
  return { landlordId, userId: landlordId, email: null, roles: ["manager"], isAdmin: false, db: {} as never };
}

const PROPOSAL: PortfolioImportProposal = {
  importId: "imp-1",
  files: [{ name: "roll.csv", kind: "spreadsheet" }],
  properties: [
    {
      key: "p1",
      address: "400 Pike St",
      source: { file: "roll.csv" },
      rooms: [],
      residents: [
        {
          key: "p1:r0",
          roomKey: null,
          name: "Sam Lee",
          email: null,
          phone: null,
          leaseStart: null,
          leaseEnd: null,
          rent: null,
          deposit: null,
          balance: null,
          status: "needs",
          gaps: [
            { field: "leaseEnd", question: "When does Sam Lee's lease end?" },
            { field: "contact", question: "What's the best email or phone for Sam Lee?" },
          ],
          source: { file: "roll.csv" },
        },
      ],
      charges: [],
      tasks: [],
      status: "needs",
    },
  ],
  summary: { properties: 1, rooms: 0, residents: 1, charges: 0, tasks: 0, gaps: 2 },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("portfolio_import_status", () => {
  it("returns the stored summary and every unresolved gap, naming the property and resident", async () => {
    loadImportProposal.mockResolvedValue({ row: { status: "draft" }, proposal: PROPOSAL });
    const result = (await portfolioImportStatusTool.handler(ctx("mgr-1"), { importId: "imp-1" })) as {
      status: string;
      summary: typeof PROPOSAL.summary;
      unresolvedGaps: { property: string; resident: string; field: string }[];
    };
    expect(loadImportProposal).toHaveBeenCalledWith({}, "mgr-1", "imp-1");
    expect(result.status).toBe("draft");
    expect(result.summary).toEqual(PROPOSAL.summary);
    expect(result.unresolvedGaps).toEqual([
      { property: "400 Pike St", resident: "Sam Lee", field: "leaseEnd", question: "When does Sam Lee's lease end?" },
      { property: "400 Pike St", resident: "Sam Lee", field: "contact", question: "What's the best email or phone for Sam Lee?" },
    ]);
  });

  it("scopes the lookup to the calling landlord — never a body/model-supplied id", async () => {
    loadImportProposal.mockResolvedValue(null);
    await expect(portfolioImportStatusTool.handler(ctx("mgr-2"), { importId: "imp-1" })).rejects.toThrow(/belongs to this landlord/);
    expect(loadImportProposal).toHaveBeenCalledWith({}, "mgr-2", "imp-1");
  });

  it("never reports numbers it computed itself — omits gaps for a resident already ready", async () => {
    const ready: PortfolioImportProposal = {
      ...PROPOSAL,
      properties: [{ ...PROPOSAL.properties[0]!, residents: [{ ...PROPOSAL.properties[0]!.residents[0]!, status: "ready", gaps: [] }] }],
    };
    loadImportProposal.mockResolvedValue({ row: { status: "completed" }, proposal: ready });
    const result = (await portfolioImportStatusTool.handler(ctx("mgr-1"), { importId: "imp-1" })) as { unresolvedGaps: unknown[] };
    expect(result.unresolvedGaps).toEqual([]);
  });
});

describe("registration", () => {
  it("is registered in the manager portal registry", () => {
    expect(agentRegistry.has("portfolio_import_status")).toBe(true);
    expect(agentRegistry.get("portfolio_import_status")!.kind).toBe("read");
  });

  it("is withheld from the manager SMS registry — portal only", () => {
    expect(MANAGER_PORTAL_ONLY_TOOLS).toContain("portfolio_import_status");
    const sms = buildManagerSmsRegistry();
    expect(sms.has("portfolio_import_status")).toBe(false);
  });
});
