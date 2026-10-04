import { beforeEach, describe, expect, it, vi } from "vitest";
import { applicationTemplateQuestionConfigFromSlice, createPropertyApplicationTemplate } from "@/lib/property-application-templates";

let signedIn: { db: unknown; userId: string } | null;
let row: Record<string, unknown> | null;
const upserts: Array<Record<string, unknown>> = [];

vi.mock("@/lib/manager-route-guard.server", () => ({ requireManagerRouteUser: async () => signedIn }));

function fakeDb() {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row ? { row_data: row } : null, error: null }) }) }),
      upsert: async (value: Record<string, unknown>) => {
        upserts.push(value);
        row = value.row_data as Record<string, unknown>;
        return { error: null };
      },
    }),
  };
}

import { GET, PUT } from "@/app/api/portal/leasing-forms/route";

const SLICE = { disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "standard" as const };

function put(body: unknown) {
  return PUT(new Request("http://localhost/api/portal/leasing-forms", { method: "PUT", body: JSON.stringify(body) }));
}

beforeEach(() => {
  signedIn = { db: fakeDb(), userId: "mgr-1" };
  row = { leasingPipeline: { applicationBeforeTour: "required" } };
  upserts.length = 0;
});

describe("/api/portal/leasing-forms", () => {
  it("refuses a caller who is not a manager", async () => {
    signedIn = null;
    expect((await GET()).status).toBe(401);
    expect((await put({ library: {} })).status).toBe(401);
  });

  it("stores the library beside the other workspace settings and reads it back with the tour order", async () => {
    const form = {
      ...createPropertyApplicationTemplate({ kind: "long-term", label: "Standard application" }),
      tourOrder: "after_tour" as const,
      draftQuestionConfig: applicationTemplateQuestionConfigFromSlice(SLICE),
    };
    const saved = await put({ library: { applications: [form], leases: [] } });
    expect(saved.status).toBe(200);
    // Other workspace settings on the same row are left alone.
    expect((upserts[0]!.row_data as Record<string, unknown>).leasingPipeline).toEqual({ applicationBeforeTour: "required" });
    const read = (await (await GET()).json()) as { library: { applications: Array<{ label: string; tourOrder: string }> } };
    expect(read.library.applications.map((item) => [item.label, item.tourOrder])).toEqual([["Standard application", "after_tour"]]);
  });

  it("never stores publication or an imported-source receipt a client sent", async () => {
    const base = createPropertyApplicationTemplate({ kind: "long-term", label: "Imported" });
    const draft = applicationTemplateQuestionConfigFromSlice(SLICE);
    await put({
      library: {
        applications: [
          {
            ...base,
            draftQuestionConfig: { ...draft, importProvenance: { sourcePath: "mgr-1/application-import/x/a.pdf", sourceName: "a.pdf" } },
            publishedQuestionConfig: { ...draft, version: 9 },
            publishedQuestionConfigVersions: [{ ...draft, version: 8 }],
          },
        ],
        leases: [],
      },
    });
    const stored = (row!.leasingForms as { applications: Array<Record<string, unknown>> }).applications[0]!;
    expect(stored.publishedQuestionConfig).toBeUndefined();
    expect(stored.publishedQuestionConfigVersions).toBeUndefined();
    expect((stored.draftQuestionConfig as Record<string, unknown>).importProvenance).toBeUndefined();
  });

  it("rejects a body with no library", async () => {
    expect((await put({})).status).toBe(400);
    expect((await put({ library: "x" })).status).toBe(400);
  });
});
