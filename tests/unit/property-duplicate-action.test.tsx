// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  duplicateManagerPropertyDraftToServer,
  readAdminPropertyRows,
} from "@/lib/demo-admin-property-inventory";

const panelSource = readFileSync("src/components/portal/pro-house-properties-panel.tsx", "utf8");

type RecordedCall = { action: string; id: string; status?: string };
let calls: RecordedCall[];

function mockFetch() {
  return vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as RecordedCall) : ({} as RecordedCall);
    if (body.action) calls.push({ action: body.action, id: body.id, status: body.status });
    return { ok: true, status: 200, json: async () => ({ records: [] }) } as unknown as Response;
  });
}

let seq = 0;
const nextManager = () => `mgr-dup-test-${(seq += 1)}`;

beforeEach(() => {
  window.history.replaceState(null, "", "/portal/properties");
  calls = [];
  window.sessionStorage.clear();
  vi.stubGlobal("fetch", mockFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("property Duplicate action", () => {
  it("writes a new draft named (copy) and never publishes", async () => {
    const manager = nextManager();
    const source = {
      ...createDefaultListingSubmission(),
      buildingName: "Proof Oak House",
      address: "12 Oak St",
    };
    const id = await duplicateManagerPropertyDraftToServer(source, manager);
    expect(id).toMatch(/^mgr-proof-oak-house-copy-/);
    expect(calls).toEqual([{ action: "upsert", id, status: "draft" }]);
    const drafts = readAdminPropertyRows(5, manager);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.buildingName).toBe("Proof Oak House (copy)");
    expect(drafts[0]?.adminRefId).toBe(id);
    expect(readAdminPropertyRows(2, manager)).toHaveLength(0);
  });

  it("exposes Duplicate on the property ⋯ menu and the detail footer", () => {
    expect(panelSource).toContain('data-attr="properties-bulk-duplicate"');
    expect(panelSource).toContain('data-attr="listing-duplicate"');
    expect(panelSource).toContain("runDuplicateSelected");
  });
});
