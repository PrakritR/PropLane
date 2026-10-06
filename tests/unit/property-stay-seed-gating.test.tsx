// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManagerPropertyApplicationQuestionsPanel } from "@/components/portal/pro-property-application-questions-panel";
import { createDefaultListingSubmission, resolveAllowedLeaseTerms, withOfferedLeaseTermsFilled } from "@/lib/manager-listing-submission";
import { persistManagerListingSubmission } from "@/lib/manager-property-save-target";
import { submissionWithDefaultLeasingSetup, submissionWithShortStayDefaults } from "@/lib/leasing-quick-add";
import { buildLeaseTemplateSeeds, syncPropertyLeaseTemplatesFromListing } from "@/lib/property-lease-template-sync";
import {
  availableApplicationTemplateSeeds,
  buildApplicationTemplateSeeds,
  syncPropertyApplicationTemplatesFromListing,
} from "@/lib/property-application-template-sync";
import { readPropertyApplicationTemplates } from "@/lib/property-application-templates";
import { readPropertyLeaseTemplates } from "@/lib/property-lease-templates";

const persist = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));
const persistPendingLocal = vi.hoisted(() => vi.fn((..._args: unknown[]) => true));
const persistDraftLocal = vi.hoisted(() => vi.fn((..._args: unknown[]) => true));
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo-property-pipeline")>();
  return {
    ...actual,
    updateExtraListingFromSubmissionOnServer: persist,
    updatePendingManagerProperty: persistPendingLocal,
  };
});
vi.mock("@/lib/demo-admin-property-inventory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo-admin-property-inventory")>();
  return { ...actual, updateManagerPropertyDraftSubmission: persistDraftLocal };
});
vi.mock("@/components/portal/pro-application-questions-editor-modal", () => ({
  ManagerApplicationQuestionsEditorModal: () => <div role="dialog">editor</div>,
}));
vi.mock("@/components/portal/property-application-template-inline-preview", () => ({
  PropertyApplicationTemplateInlinePreview: () => <div>preview</div>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/portal/properties/all/demo-prop-maple/application",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
  persist.mockClear();
  persistPendingLocal.mockClear();
  persistDraftLocal.mockClear();
});

const longOnly = { allowedLeaseTerms: ["Long-term"], shortTermRentalsAllowed: false, airbnbRentalsAllowed: false };
const withShort = { allowedLeaseTerms: ["Long-term", "Short-Term Stay"], shortTermRentalsAllowed: true, airbnbRentalsAllowed: false };
const withAirbnb = { ...withShort, airbnbRentalsAllowed: true };
const keys = (rows: { seedKey: string }[]) => rows.map((row) => row.seedKey);

describe("short-stay defaults exist only on a property that allows that stay", () => {
  it("a long-term-only property is seeded with a long-term lease and application plus the co-signer form, never a short-term one", () => {
    const sub = { ...createDefaultListingSubmission(), ...longOnly };
    expect(keys(buildLeaseTemplateSeeds(sub))).toEqual(["primary"]);
    expect(keys(buildApplicationTemplateSeeds(sub))).toEqual(["primary", "cosigner"]);

    const setup = submissionWithDefaultLeasingSetup(sub);
    expect(readPropertyLeaseTemplates(setup).map((row) => row.listingSeedKey)).toEqual(["primary"]);
    expect(readPropertyApplicationTemplates(setup).map((row) => row.listingSeedKey).sort()).toEqual(["cosigner", "primary"]);
  });

  it("a property that never stated a choice offers long term alone, so it gets no short-term seed either", () => {
    expect(keys(buildLeaseTemplateSeeds(createDefaultListingSubmission()))).toEqual(["primary"]);
    expect(keys(buildApplicationTemplateSeeds(createDefaultListingSubmission()))).not.toContain("short-term");
  });

  it("short term allowed adds the short-term seeds; Airbnb adds its own", () => {
    expect(keys(buildLeaseTemplateSeeds({ ...createDefaultListingSubmission(), ...withShort }))).toEqual(["primary", "short-term"]);
    expect(keys(buildLeaseTemplateSeeds({ ...createDefaultListingSubmission(), ...withAirbnb }))).toEqual([
      "primary",
      "short-term",
      "airbnb",
    ]);
    // Airbnb is itself a short stay: ticking it makes the property a short-stay one.
    expect(keys(buildLeaseTemplateSeeds({ ...createDefaultListingSubmission(), ...longOnly, airbnbRentalsAllowed: true }))).toEqual([
      "primary",
      "short-term",
      "airbnb",
    ]);
  });

  it("ticking Short term adds the short-term application and lease to a property that already stored its setup", () => {
    const stored = submissionWithDefaultLeasingSetup({ ...createDefaultListingSubmission(), ...longOnly });
    const next = submissionWithShortStayDefaults({ ...stored, ...withShort });
    expect(readPropertyLeaseTemplates(next).map((row) => row.listingSeedKey)).toContain("short-term");
    expect(readPropertyApplicationTemplates(next).map((row) => row.listingSeedKey)).toContain("short-term");
    // Idempotent: ticking again adds nothing twice.
    expect(readPropertyApplicationTemplates(submissionWithShortStayDefaults(next))).toHaveLength(readPropertyApplicationTemplates(next).length);
  });

  it("an untouched short-term default stored before the gate is kept, switched off, and comes back on when short term is allowed", () => {
    const stored = submissionWithDefaultLeasingSetup({ ...createDefaultListingSubmission(), ...withShort });
    expect(readPropertyApplicationTemplates(stored).map((row) => row.listingSeedKey)).toContain("short-term");

    const longNow = syncPropertyApplicationTemplatesFromListing({ ...stored, ...longOnly });
    const hidden = readPropertyApplicationTemplates(longNow).find((row) => row.listingSeedKey === "short-term");
    expect(hidden).toMatchObject({ offered: false, stayHidden: true });
    // Nothing is conjured or duplicated for it either.
    expect(keys(availableApplicationTemplateSeeds(longNow))).toEqual([]);

    const back = readPropertyApplicationTemplates(syncPropertyApplicationTemplatesFromListing({ ...longNow, ...withShort })).find(
      (row) => row.listingSeedKey === "short-term",
    );
    expect(back?.offered).toBe(true);
    expect(back?.stayHidden).toBeUndefined();
  });
});

describe("a default the property has not stored yet keeps one id", () => {
  it("rebuilding the unstored defaults on every read gives the same ids, so an open Preview or Edit still finds its row", () => {
    const sub = { ...createDefaultListingSubmission(), ...withShort };
    const first = readPropertyApplicationTemplates(syncPropertyApplicationTemplatesFromListing(sub)).map((row) => row.id);
    const second = readPropertyApplicationTemplates(syncPropertyApplicationTemplatesFromListing(sub)).map((row) => row.id);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });
});

describe("saving a property that never stored a submission", () => {
  it("fills the empty lease-term list with what the screens showed, so the server accepts it", () => {
    const empty = createDefaultListingSubmission();
    expect(empty.allowedLeaseTerms).toEqual([]);
    const filled = withOfferedLeaseTermsFilled(empty);
    expect(resolveAllowedLeaseTerms(filled)).toEqual(["Long-term"]);
    // A stored choice and a legacy row naming no list are left exactly as they are.
    const chosen = { ...empty, ...withShort };
    expect(withOfferedLeaseTermsFilled(chosen)).toBe(chosen);
    const legacy = { ...empty, allowedLeaseTerms: undefined };
    expect(withOfferedLeaseTermsFilled(legacy)).toBe(legacy);
  });

  function renderPanel(sub: ReturnType<typeof createDefaultListingSubmission>) {
    const props = {
      saveTarget: { mode: "listing", saveId: "demo-prop-maple" } as const,
      managerUserId: "mgr-1",
      settingsPropertyId: "demo-prop-maple",
      onUpdated: () => {},
      showToast: () => {},
    };
    const view = render(<ManagerPropertyApplicationQuestionsPanel sub={sub} {...props} />);
    return { view, props };
  }
  const openRowAction = async (name: string) => {
    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Long-term application" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name }));
  };

  it("Edit on such a property saves with lease terms and opens the editor (it used to fail with a save toast)", async () => {
    renderPanel(createDefaultListingSubmission());
    await openRowAction("Edit");
    await screen.findByRole("dialog");
    expect(persist).toHaveBeenCalledTimes(1);
    const saved = persist.mock.calls[0]![2] as ReturnType<typeof createDefaultListingSubmission>;
    expect(resolveAllowedLeaseTerms(saved)).toEqual(["Long-term"]);
  });

  it("Preview stays open when the listing re-reads (a sync hands the panel an equal submission)", async () => {
    const sub = createDefaultListingSubmission();
    const { view, props } = renderPanel(sub);
    await openRowAction("Preview");
    await screen.findByRole("dialog");
    view.rerender(<ManagerPropertyApplicationQuestionsPanel sub={{ ...sub }} {...props} />);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("the local persist mirrors nothing the server would refuse", () => {
  it("a pending write carries the lease terms the screens showed; a draft keeps its unchosen stays", () => {
    const empty = createDefaultListingSubmission();
    expect(persistManagerListingSubmission({ mode: "pending", saveId: "pending-1" }, "mgr-1", empty)).toBe(true);
    expect(resolveAllowedLeaseTerms(persistPendingLocal.mock.calls[0]![1] as typeof empty)).toEqual(["Long-term"]);

    // A draft is unfinished by definition and the server exempts it, so nothing chooses a stay for it.
    expect(persistManagerListingSubmission({ mode: "draft", saveId: "draft-1" }, "mgr-1", empty)).toBe(true);
    expect((persistDraftLocal.mock.calls[0]![2] as typeof empty).allowedLeaseTerms).toEqual([]);
  });
});

describe("hiding a short-stay default remembers whether the manager had it on", () => {
  const shortTermRow = (sub: ReturnType<typeof createDefaultListingSubmission>) =>
    readPropertyApplicationTemplates(sub).find((row) => row.listingSeedKey === "short-term");
  const shortTermLease = (sub: ReturnType<typeof createDefaultListingSubmission>) =>
    readPropertyLeaseTemplates(sub).find((row) => row.listingSeedKey === "short-term");

  it("a default the manager switched OFF is still off when short term is allowed again", () => {
    const stored = submissionWithDefaultLeasingSetup({ ...createDefaultListingSubmission(), ...withShort });
    const switchedOff = {
      ...stored,
      propertyApplicationTemplates: readPropertyApplicationTemplates(stored).map((row) =>
        row.listingSeedKey === "short-term" ? { ...row, offered: false } : row,
      ),
      propertyLeaseTemplates: readPropertyLeaseTemplates(stored).map((row) =>
        row.listingSeedKey === "short-term" ? { ...row, offered: false } : row,
      ),
    };

    const longNow = syncPropertyLeaseTemplatesFromListing(
      syncPropertyApplicationTemplatesFromListing({ ...switchedOff, ...longOnly }),
    );
    expect(shortTermRow(longNow)).toMatchObject({ offered: false, stayHidden: true, stayHiddenOffered: false });
    expect(shortTermLease(longNow)).toMatchObject({ offered: false, stayHidden: true, stayHiddenOffered: false });
    // A second sync while the stay is still off must not record the hidden row's own `offered: false`.
    const again = syncPropertyLeaseTemplatesFromListing(syncPropertyApplicationTemplatesFromListing(longNow));

    const back = syncPropertyLeaseTemplatesFromListing(
      syncPropertyApplicationTemplatesFromListing({ ...again, ...withShort }),
    );
    expect(shortTermRow(back)).toMatchObject({ offered: false });
    expect(shortTermRow(back)?.stayHidden).toBeUndefined();
    expect(shortTermLease(back)).toMatchObject({ offered: false });
    expect(shortTermLease(back)?.stayHidden).toBeUndefined();
  });

  it("an untouched default the manager never switched off still comes back on", () => {
    const stored = submissionWithDefaultLeasingSetup({ ...createDefaultListingSubmission(), ...withShort });
    const longNow = syncPropertyApplicationTemplatesFromListing({ ...stored, ...longOnly });
    expect(shortTermRow(longNow)).toMatchObject({ stayHidden: true, stayHiddenOffered: true });
    const back = syncPropertyApplicationTemplatesFromListing({ ...longNow, ...withShort });
    expect(shortTermRow(back)?.offered).toBe(true);
  });
});
