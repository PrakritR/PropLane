/**
 * Portfolio import — `portfolio-import.client.ts` unwraps each route's real
 * response envelope. Every route answers `{ ok: true, <field(s)> }`; a
 * caller that casts the WHOLE envelope as the field (instead of reading the
 * nested field out) gets a `proposal`/`result` one level too deep, and every
 * reader crashes on `proposal.files[0]` — the exact shape a live browser run
 * against the real routes caught (unit tests mock these helpers away, so
 * this boundary needs its own coverage against a real fetch Response shape).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFromPortfolioImport,
  getPortfolioImport,
  patchPortfolioImport,
  uploadPortfolioImport,
} from "@/lib/portfolio-import.client";

const PROPOSAL = {
  importId: "imp-1",
  files: [{ name: "roll.csv", kind: "spreadsheet" as const }],
  properties: [],
  summary: { properties: 0, rooms: 0, residents: 0, charges: 0, tasks: 0, gaps: 0 },
};

function fetchReturning(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("portfolio-import.client.ts — response unwrap", () => {
  it("uploadPortfolioImport reads the nested `proposal`, not the whole `{ ok, proposal }` envelope", async () => {
    vi.stubGlobal("fetch", fetchReturning(200, { ok: true, proposal: PROPOSAL }));
    const result = await uploadPortfolioImport([new File(["a"], "roll.csv")], "");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.proposal).toEqual(PROPOSAL);
    // The bug this guards against: casting the envelope itself as the
    // proposal leaves a phantom `.ok` key and puts every real field one
    // level too deep (`result.proposal.proposal`, not `result.proposal`).
    expect((result.proposal as unknown as { ok?: boolean }).ok).toBeUndefined();
    expect(result.proposal.files[0]?.name).toBe("roll.csv");
  });

  it("getPortfolioImport reads the nested `proposal`", async () => {
    vi.stubGlobal("fetch", fetchReturning(200, { ok: true, proposal: PROPOSAL, status: "draft" }));
    const result = await getPortfolioImport("imp-1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.proposal).toEqual(PROPOSAL);
  });

  it("patchPortfolioImport reads the nested `proposal`", async () => {
    vi.stubGlobal("fetch", fetchReturning(200, { ok: true, proposal: PROPOSAL }));
    const result = await patchPortfolioImport("imp-1", { skips: ["p1:room:2"] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.proposal).toEqual(PROPOSAL);
  });

  it("createFromPortfolioImport reads `created`/`failures` out of the spread envelope, not `ok` along with them", async () => {
    const created = { properties: 1, rooms: 2, residents: 1, leases: 1, charges: 2, tasks: 1, invites: 0 };
    vi.stubGlobal("fetch", fetchReturning(200, { ok: true, created, failures: [] }));
    const result = await createFromPortfolioImport("imp-1", { sendInvites: false });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.result).toEqual({ created, failures: [] });
    expect(Object.keys(result.result)).toEqual(["created", "failures"]);
  });

  it("a 4xx from any route still returns the server's plain error message", async () => {
    vi.stubGlobal("fetch", fetchReturning(400, { ok: false, error: "At least one file is required." }));
    const result = await uploadPortfolioImport([], "");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("At least one file is required.");
  });
});
