/**
 * A lease must never name "[LANDLORD ENTITY NAME]" as a contracting party.
 *
 * The template had no landlord name to print — PropLane never collected one — so it fell back to
 * the listing's BUILDING name, which is a place rather than a legal person, and then to that
 * literal placeholder, which shipped onto the Parties and signature blocks of documents residents
 * were asked to sign.
 *
 * The fix is two-sided and both halves matter: the manager's account full name is used as the
 * landlord party, and the send gate refuses any lease still carrying the placeholder. Shipping the
 * the send gate refuses any lease still carrying the placeholder. Shipping the gate WITHOUT the
 * field would have blocked every send with no way out, which is why these assert the escape hatch
 * as carefully as the block.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  leaseLandlordNameBlocker,
  leaseLandlordPartyNameFromHtml,
} from "@/lib/lease-pipeline-storage";
import {
  LEASE_LANDLORD_PLACEHOLDER,
  MAX_LANDLORD_LEGAL_NAME_LENGTH,
  cacheLandlordLegalName,
  cachedLandlordLegalName,
  fetchAndCacheLandlordLegalName,
  landlordLegalNameFromAccountFullName,
  normalizeManagerLandlordProfile,
  validateLandlordLegalName,
} from "@/lib/manager-landlord-profile";
import { setWorkspaceSelection } from "@/lib/workspaces/selection";
import type { WorkspacePayload } from "@/lib/workspaces/types";

const row = (over: Record<string, unknown> = {}) =>
  ({ id: "lease-1", residentEmail: "a@b.com", ...over }) as never;

const partiesHtml = (landlordName: string) =>
  `<table><tr><th>Landlord / Operator</th><td><strong>${landlordName}</strong><br/>Mailing address: 1 Main</td></tr></table>`;

const workspacePayload = (activeWorkspaceId: string): WorkspacePayload =>
  ({ workspaces: [], activeWorkspaceId }) as unknown as WorkspacePayload;

describe("landlord-name send gate", () => {
  beforeEach(() => {
    // The cache only answers for a named workspace, so the gate's fixtures need one selected.
    setWorkspaceSelection(workspacePayload("ws-gate"));
    cacheLandlordLegalName("Doe Property Holdings LLC");
  });

  afterEach(() => {
    cacheLandlordLegalName("");
    setWorkspaceSelection(null);
  });

  it("blocks a lease that still names the placeholder", () => {
    const blocker = leaseLandlordNameBlocker(
      row({ generatedHtml: `<p>Landlord: ${LEASE_LANDLORD_PLACEHOLDER}</p>` }),
    );
    expect(blocker).toBeTruthy();
    expect(blocker).toMatch(/Settings/i);
    expect(blocker).toMatch(/regenerate/i);
  });

  it("blocks when the manager has not configured a profile name", () => {
    cacheLandlordLegalName("");
    expect(leaseLandlordNameBlocker(row({ generatedHtml: partiesHtml("5259 Brooklyn Ave NE") }))).toMatch(
      /Settings/i,
    );
  });

  it("blocks when the parties row does not match the configured landlord name", () => {
    expect(leaseLandlordNameBlocker(row({ generatedHtml: partiesHtml("5259 Brooklyn Ave NE") }))).toMatch(
      /Regenerate/i,
    );
  });

  it("allows a lease that names the configured landlord", () => {
    expect(
      leaseLandlordNameBlocker(row({ generatedHtml: partiesHtml("Doe Property Holdings LLC") })),
    ).toBeNull();
  });

  it("reads the landlord party from the parties row", () => {
    expect(leaseLandlordPartyNameFromHtml(partiesHtml("Jane Doe"))).toBe("Jane Doe");
  });

  it("ignores a row with no generated document", () => {
    expect(leaseLandlordNameBlocker(row())).toBeNull();
    expect(leaseLandlordNameBlocker(row({ managerUploadedPdf: { dataUrl: "data:..." } }))).toBeNull();
  });
});

describe("the cached landlord name belongs to ONE workspace", () => {
  const payload = workspacePayload;

  afterEach(() => {
    setWorkspaceSelection(null);
    cacheLandlordLegalName("");
  });

  it("reads back the active workspace's own name", () => {
    setWorkspaceSelection(payload("ws-a"));
    cacheLandlordLegalName("Alpha Holdings LLC");
    expect(cachedLandlordLegalName()).toBe("Alpha Holdings LLC");
  });

  it("is a MISS from another workspace, so the gate refuses instead of printing the wrong party", () => {
    setWorkspaceSelection(payload("ws-a"));
    cacheLandlordLegalName("Alpha Holdings LLC");
    setWorkspaceSelection(payload("ws-b"));
    expect(cachedLandlordLegalName()).toBe("");
    expect(leaseLandlordNameBlocker(row({ generatedHtml: partiesHtml("Alpha Holdings LLC") }))).toMatch(/Settings/i);
  });

  it("caches the workspace a name was READ for, not whichever is active", () => {
    setWorkspaceSelection(payload("ws-a"));
    cacheLandlordLegalName("Beta Homes LLC", "ws-b");
    expect(cachedLandlordLegalName()).toBe("");
    setWorkspaceSelection(payload("ws-b"));
    expect(cachedLandlordLegalName()).toBe("Beta Homes LLC");
  });

  it("holds nothing before a workspace is selected, so the gate refuses the account rung's name", () => {
    setWorkspaceSelection(null);
    cacheLandlordLegalName("Account Rung Holdings LLC");
    expect(cachedLandlordLegalName()).toBe("");
    setWorkspaceSelection(payload("ws-a"));
    expect(cachedLandlordLegalName()).toBe("");
    expect(leaseLandlordNameBlocker(row({ generatedHtml: partiesHtml("Account Rung Holdings LLC") }))).toMatch(
      /Settings/i,
    );
  });

  it("never reads the server unqualified: no workspace, no fetch and no cache", async () => {
    setWorkspaceSelection(payload("ws-a"));
    cacheLandlordLegalName("Alpha Holdings LLC");
    const store = new Map<string, string>();
    const fetchMock = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await fetchAndCacheLandlordLegalName(null)).toBe("");
      expect(await fetchAndCacheLandlordLegalName("   ")).toBe("");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(cachedLandlordLegalName()).toBe("Alpha Holdings LLC");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("landlord legal name validation", () => {
  it("derives the lease landlord name from account full name", () => {
    expect(landlordLegalNameFromAccountFullName("Jane Doe")).toBe("Jane Doe");
    expect(landlordLegalNameFromAccountFullName("  Doe   Holdings   LLC ")).toBe("Doe Holdings LLC");
    expect(landlordLegalNameFromAccountFullName("")).toBe("");
  });

  it("accepts a person and an entity", () => {
    expect(validateLandlordLegalName("Jane Doe")).toEqual({ ok: true, landlordLegalName: "Jane Doe" });
    expect(validateLandlordLegalName("Doe Property Holdings LLC")).toEqual({
      ok: true,
      landlordLegalName: "Doe Property Holdings LLC",
    });
  });

  it("allows clearing the name", () => {
    // A manager may be mid-setup. The send gate, not the field, is what protects the document.
    expect(validateLandlordLegalName("")).toEqual({ ok: true, landlordLegalName: "" });
    expect(validateLandlordLegalName(null)).toEqual({ ok: true, landlordLegalName: "" });
    expect(validateLandlordLegalName("   ")).toEqual({ ok: true, landlordLegalName: "" });
  });

  it("collapses stray whitespace rather than printing it on a contract", () => {
    expect(validateLandlordLegalName("  Doe   Holdings   LLC ")).toEqual({
      ok: true,
      landlordLegalName: "Doe Holdings LLC",
    });
  });

  it("rejects a single stray character", () => {
    expect(validateLandlordLegalName("x").ok).toBe(false);
  });

  it("rejects angle brackets", () => {
    expect(validateLandlordLegalName("<script>").ok).toBe(false);
  });

  it("rejects an absurdly long value", () => {
    expect(validateLandlordLegalName("A".repeat(MAX_LANDLORD_LEGAL_NAME_LENGTH + 1)).ok).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(validateLandlordLegalName(42).ok).toBe(false);
  });
});

describe("stored landlord profile", () => {
  it("reads a missing or junk row as unset", () => {
    for (const raw of [null, undefined, {}, "nope", 7, []]) {
      expect(normalizeManagerLandlordProfile(raw).landlordLegalName).toBe("");
    }
  });

  it("truncates rather than storing an unbounded name", () => {
    const long = normalizeManagerLandlordProfile({ landlordLegalName: "A".repeat(500) });
    expect(long.landlordLegalName).toHaveLength(MAX_LANDLORD_LEGAL_NAME_LENGTH);
  });
});
