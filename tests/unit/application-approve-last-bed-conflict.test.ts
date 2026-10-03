// The last bed is arbitrated by the server when the approval is written. A refusal names the bed and who
// holds it, nothing is written locally for the refused approval, and a patch (the bed + its rent from the
// Approve popup) reaches the server write and the local copy only once the server accepts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";

let ROWS: DemoApplicantRow[] = [];
const writes: DemoApplicantRow[][] = [];

vi.mock("@/lib/manager-applications-storage", () => ({
  normalizeApplicationAxisId: (id: string) => id,
  readManagerApplicationRows: () => ROWS,
  writeManagerApplicationRows: (rows: DemoApplicantRow[]) => {
    writes.push(rows);
    ROWS = rows;
  },
}));
vi.mock("@/lib/household-charges", () => ({
  recordApprovedApplicationCharges: () => true,
  recordSubmittedApplicationFeeCharge: () => true,
  removeAllApplicationCharges: () => undefined,
  removeApprovedApplicationCharges: () => undefined,
}));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));

import { transitionApplicationBucket } from "@/lib/application-review";

const row = (over: Partial<DemoApplicantRow> = {}): DemoApplicantRow =>
  ({
    id: "AP1",
    name: "Marcus Hale",
    email: "marcus@example.com",
    property: "Alder House",
    stage: "Submitted",
    bucket: "pending",
    detail: "",
    application: { roomChoice1: "p::r8", residentSlot: 2 },
    ...over,
  }) as unknown as DemoApplicantRow;

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const r = handler(String(url), init);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body, clone() { return this; } } as unknown as Response;
    }),
  );
}

beforeEach(() => {
  ROWS = [row()];
  writes.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe("approving a bed that was just taken", () => {
  it("answers blocked: capacity with the bed and the holder, and writes nothing locally", async () => {
    mockFetch(() => ({ status: 409, body: { ok: false, blocked: "capacity", error: "That rent is already held by Nora Vance", conflict: { slot: 2, holderName: "Nora Vance" } } }));
    const result = await transitionApplicationBucket("AP1", "approved", { userId: "u1" });
    expect(result).toMatchObject({ blocked: "capacity", conflict: { slot: 2, holderName: "Nora Vance" } });
    expect(writes).toEqual([]);
    expect(ROWS[0]!.bucket).toBe("pending");
  });

  it("a capacity refusal with no detail still blocks and writes nothing", async () => {
    mockFetch(() => ({ status: 409, body: { ok: false, blocked: "capacity", error: "Room is full" } }));
    const result = await transitionApplicationBucket("AP1", "approved", { userId: "u1" });
    expect(result?.blocked).toBe("capacity");
    expect(result?.conflict).toEqual({});
    expect(writes).toEqual([]);
  });

  it("the bed patch reaches the server write, and the local copy only after the server accepts", async () => {
    let sent: DemoApplicantRow | null = null;
    mockFetch((url, init) => {
      if (url.includes("/api/manager-applications")) {
        sent = JSON.parse(String(init?.body)).row;
        return { status: 200, body: { ok: true } };
      }
      return { status: 200, body: {} };
    });
    const result = await transitionApplicationBucket("AP1", "approved", {
      userId: "u1",
      applicationPatch: { residentSlot: 1, managerRentOverride: "650" },
      skipWelcomeEmail: true,
    });
    expect(result?.blocked).toBeUndefined();
    expect(sent!.application).toMatchObject({ residentSlot: 1, managerRentOverride: "650", roomChoice1: "p::r8" });
    expect(ROWS[0]!.application).toMatchObject({ residentSlot: 1, managerRentOverride: "650" });
    expect(ROWS[0]!.bucket).toBe("approved");
  });
});
