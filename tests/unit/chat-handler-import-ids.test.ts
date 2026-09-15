/**
 * `applyImportAttachments` (src/lib/agent/chat-handler.ts): a rent-roll
 * attachment already created a portfolio import draft client-side
 * (assistant-chat-attachments.client.ts); this re-verifies every id against
 * the calling landlord before letting the model see it, and never fails the
 * whole turn over an id that is not owned — it is dropped silently.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

const loadPortfolioImportMock = vi.fn();
const summaryForMock = vi.fn();

vi.mock("@/lib/portfolio-import/store.server", () => ({
  loadPortfolioImport: (...args: unknown[]) => loadPortfolioImportMock(...args),
  summaryFor: (...args: unknown[]) => summaryForMock(...args),
}));

const { applyImportAttachments } = await import("@/lib/agent/chat-handler");

const LANDLORD = "landlord-1";
const OWNED_ID = "44444444-4444-4444-8444-444444444444";
const FOREIGN_ID = "55555555-5555-4555-8555-555555555555";

function userMessage(text: string): Anthropic.MessageParam {
  return { role: "user", content: text };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyImportAttachments", () => {
  it("appends a note naming the importId, file name, and counts for an owned import", async () => {
    loadPortfolioImportMock.mockImplementation(async (_db: unknown, landlordId: string, importId: string) =>
      landlordId === LANDLORD && importId === OWNED_ID ? { id: OWNED_ID, draft: { version: 1 } } : null,
    );
    summaryForMock.mockReturnValue({
      fileName: "maple-court-rent-roll.csv",
      propertyCount: 2,
      unitCount: 7,
      residentCount: 6,
      blockingIssueCount: 1,
    });

    const messages = [userMessage("Please set this up")];
    const result = await applyImportAttachments({ db: {} as never, landlordId: LANDLORD }, messages, {
      importIds: [OWNED_ID],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.importCount).toBe(1);
    expect(loadPortfolioImportMock).toHaveBeenCalledWith(expect.anything(), LANDLORD, OWNED_ID);
    const last = result.messages[result.messages.length - 1];
    expect(typeof last?.content).toBe("string");
    const text = String(last?.content);
    expect(text).toContain("Please set this up");
    expect(text).toContain(OWNED_ID);
    expect(text).toContain("maple-court-rent-roll.csv");
    expect(text).toContain("2 properties");
    expect(text).toContain("7 units");
    expect(text).toContain("6 residents");
    expect(text).toContain("1 blocking issues");
  });

  it("drops an importId that does not belong to this landlord without failing the turn", async () => {
    loadPortfolioImportMock.mockResolvedValue(null);

    const messages = [userMessage("Please set this up")];
    const result = await applyImportAttachments({ db: {} as never, landlordId: LANDLORD }, messages, {
      importIds: [FOREIGN_ID],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.importCount).toBe(0);
    // Unowned id: message passes through completely unchanged.
    expect(result.messages).toEqual(messages);
  });

  it("mixes an owned and a foreign id, noting only the owned one", async () => {
    loadPortfolioImportMock.mockImplementation(async (_db: unknown, _landlordId: string, importId: string) =>
      importId === OWNED_ID ? { id: OWNED_ID, draft: { version: 1 } } : null,
    );
    summaryForMock.mockReturnValue({
      fileName: "rent-roll.csv",
      propertyCount: 1,
      unitCount: 1,
      residentCount: 1,
      blockingIssueCount: 0,
    });

    const result = await applyImportAttachments(
      { db: {} as never, landlordId: LANDLORD },
      [userMessage("hi")],
      { importIds: [FOREIGN_ID, OWNED_ID] },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.importCount).toBe(1);
    const text = String(result.messages[result.messages.length - 1]?.content);
    expect(text).toContain(OWNED_ID);
    expect(text).not.toContain(FOREIGN_ID);
  });

  it("passes messages through unchanged when there are no importIds", async () => {
    const messages = [userMessage("hi")];
    const result = await applyImportAttachments({ db: {} as never, landlordId: LANDLORD }, messages, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.importCount).toBe(0);
    expect(result.messages).toBe(messages);
    expect(loadPortfolioImportMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed importIds payload", async () => {
    const result = await applyImportAttachments(
      { db: {} as never, landlordId: LANDLORD },
      [userMessage("hi")],
      { importIds: "not-an-array" },
    );
    expect(result.ok).toBe(false);
  });

  it("requires a trailing user message before it can append a note", async () => {
    loadPortfolioImportMock.mockResolvedValue({ id: OWNED_ID, draft: { version: 1 } });
    summaryForMock.mockReturnValue({ fileName: "x.csv", propertyCount: 1, unitCount: 1, residentCount: 1, blockingIssueCount: 0 });

    const result = await applyImportAttachments(
      { db: {} as never, landlordId: LANDLORD },
      [{ role: "assistant", content: "hello" }],
      { importIds: [OWNED_ID] },
    );
    expect(result.ok).toBe(false);
  });
});
