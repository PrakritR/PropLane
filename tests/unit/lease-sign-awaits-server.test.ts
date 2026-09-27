// @vitest-environment jsdom
/**
 * Part 3 hotfix, defects 2 and 3:
 *
 * 2. Signing used to save in the browser FIRST, then POST in the background
 *    and ignore any error (`write()`, fire-and-forget). The resident saw
 *    "Lease signed" even when the server refused it, and the lease quietly
 *    flipped back to unsigned on the next refresh.
 * 3. The signature hash was taken from whatever copy of the document the
 *    signer's browser happened to hold — the resident's is the SLIM list
 *    projection with no bytes at all — so the hash could be of nothing.
 *
 * `residentSignLease` / `managerSignLease` now load the full document first
 * and await the server before reporting success.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  managerSignLease,
  normalizeLeasePipelineRow,
  readLeasePipeline,
  residentSignLease,
  seedDemoLeasePipeline,
} from "@/lib/lease-pipeline-storage";
import { projectLeasePipelineListRow } from "@/lib/lease-pipeline-list-projection";

const MANAGER_ID = "manager-sign-awaits";
const LEASE_HTML = "<html><body>FULL LEASE TEXT, v1</body></html>";

function independentSha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function fullRow(overrides: Record<string, unknown> = {}) {
  return normalizeLeasePipelineRow({
    id: "lease_sign_awaits",
    residentName: "Jordan Lee",
    residentEmail: "jordan.lee@example.com",
    unit: "Unit A",
    pdfVersion: 1,
    notes: "",
    updatedAtIso: "2026-09-24T00:00:00.000Z",
    managerUserId: MANAGER_ID,
    thread: [],
    generatedHtml: LEASE_HTML,
    generatedAtIso: "2026-09-24T00:00:00.000Z",
    ...overrides,
  });
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/portal/leases");
});

describe("residentSignLease — waits for the server (defect 2)", () => {
  const RESIDENT_SCOPE = "";

  it("returns {ok:false, error} and never marks the lease signed when the server refuses", async () => {
    seedDemoLeasePipeline(
      [fullRow({ bucket: "resident", status: "Resident Signature Pending", sentToResidentAt: "2026-09-24T00:00:00.000Z" })],
      RESIDENT_SCOPE,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "This lease changed after you opened it. Reload it and sign again." }), { status: 409 })),
    );

    const result = await residentSignLease("jordan.lee@example.com", "Jordan Lee");

    expect(result).toEqual({ ok: false, error: "This lease changed after you opened it. Reload it and sign again." });
    const row = readLeasePipeline().find((r) => r.id === "lease_sign_awaits")!;
    // Nothing is marked signed locally — the write never landed anywhere.
    expect(row.residentSignature).toBeNull();
    expect(row.status).toBe("Resident Signature Pending");
    expect(row.bucket).toBe("resident");
  });

  it("only marks the lease signed once the server has confirmed it", async () => {
    seedDemoLeasePipeline(
      [fullRow({ bucket: "resident", status: "Resident Signature Pending", sentToResidentAt: "2026-09-24T00:00:00.000Z" })],
      RESIDENT_SCOPE,
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const result = await residentSignLease("jordan.lee@example.com", "Jordan Lee");

    expect(result).toEqual({ ok: true });
    const row = readLeasePipeline().find((r) => r.id === "lease_sign_awaits")!;
    expect(row.residentSignature?.name).toBe("Jordan Lee");
    expect(row.status).toBe("Manager Signature Pending");
  });
});

describe("residentSignLease — hashes the FULL document, never the slim list copy (defect 3)", () => {
  const RESIDENT_SCOPE = "";

  it("loads the full document before signing when the local copy is slim", async () => {
    const full = fullRow({ bucket: "resident", status: "Resident Signature Pending", sentToResidentAt: "2026-09-24T00:00:00.000Z" });
    // Seed the SLIM projection — exactly what a fresh browser session actually
    // holds after `syncLeasePipelineFromServer`'s GET.
    seedDemoLeasePipeline([projectLeasePipelineListRow(full)], RESIDENT_SCOPE);
    const slimBeforeSign = readLeasePipeline().find((r) => r.id === "lease_sign_awaits")!;
    // `normalizeLeasePipelineRow` collapses the slim projection's empty string
    // to null (`stripLeaseAiDisclaimerFromHtml`) — either way, no bytes.
    expect(slimBeforeSign.generatedHtml).toBeFalsy();
    expect(slimBeforeSign.documentOmitted).toBe(true);

    let sawDetailFetch = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") return new Response("{}", { status: 200 });
        // The detail GET — the same request the manager's own preview already
        // used (`ensureLeaseDocumentLoaded`) — hands back the full row.
        sawDetailFetch = true;
        expect(url).toContain("/api/portal-lease-pipeline?id=");
        return new Response(JSON.stringify({ rows: [full] }), { status: 200 });
      }),
    );

    const result = await residentSignLease("jordan.lee@example.com", "Jordan Lee");

    expect(sawDetailFetch).toBe(true);
    expect(result).toEqual({ ok: true });
    const row = readLeasePipeline().find((r) => r.id === "lease_sign_awaits")!;
    // The hash is of the REAL loaded document, never null/empty.
    expect(row.residentSignature?.documentSha256).toBe(independentSha256(LEASE_HTML));
  });

  it("refuses to sign when the document never finishes loading", async () => {
    const full = fullRow({ bucket: "resident", status: "Resident Signature Pending", sentToResidentAt: "2026-09-24T00:00:00.000Z" });
    seedDemoLeasePipeline([projectLeasePipelineListRow(full)], RESIDENT_SCOPE);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Server error", { status: 500 })));

    const result = await residentSignLease("jordan.lee@example.com", "Jordan Lee");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/could not be loaded/i);
    const row = readLeasePipeline().find((r) => r.id === "lease_sign_awaits")!;
    expect(row.residentSignature).toBeNull();
  });
});

describe("managerSignLease — same two invariants for the countersign", () => {
  it("returns {ok:false, error} without marking a countersign the server refused", async () => {
    seedDemoLeasePipeline(
      [
        fullRow({
          bucket: "signed",
          status: "Manager Signature Pending",
          sentToResidentAt: "2026-09-24T00:00:00.000Z",
          residentSignedAt: "2026-09-24T01:00:00.000Z",
          residentSignature: {
            role: "resident",
            name: "Jordan Lee",
            signedAtIso: "2026-09-24T01:00:00.000Z",
            documentSha256: independentSha256(LEASE_HTML),
          },
        }),
      ],
      MANAGER_ID,
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Refused." }), { status: 409 })));

    const result = await managerSignLease("lease_sign_awaits", "Pat Manager", MANAGER_ID);

    expect(result).toEqual({ ok: false, error: "Refused." });
    const row = readLeasePipeline(MANAGER_ID).find((r) => r.id === "lease_sign_awaits")!;
    expect(row.managerSignature).toBeNull();
    expect(row.status).toBe("Manager Signature Pending");
  });
});
