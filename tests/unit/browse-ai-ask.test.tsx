// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("posthog-js", () => ({ default: { get_distinct_id: () => "d" } }));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
vi.mock("@/hooks/use-public-listings", () => ({
  usePublicListings: () => ({ listings: [], loading: false, occupancyReady: true }),
}));

import { ResidentHousingBrowse } from "@/components/marketing/resident-housing-browse";
import { ResidentHousingChat } from "@/components/marketing/resident-listing-search";
import { browseStateFromChatFilters, describeChatFilters } from "@/lib/housing-chat-filters";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BOUNDS = { min: 500, max: 6500, step: 100 };

describe("browseStateFromChatFilters", () => {
  it("maps every returned field, including pets, lease types and the budget floor", () => {
    const state = browseStateFromChatFilters(
      {
        moveIn: "2026-11-01",
        moveOut: "2027-02-01",
        minBudget: 840,
        maxBudget: 1230,
        bedroom: "2",
        bathroom: "private",
        petFriendly: true,
        neighborhood: "University District",
        leaseTypes: ["short_term", "month_to_month"],
      },
      BOUNDS,
    );
    expect(state).toEqual({
      moveIn: "2026-11-01",
      moveOut: "2027-02-01",
      budgetMin: 800,
      budgetMax: 1200,
      roomType: "2",
      bathroom: "private",
      petsOnly: true,
      neighborhood: "University District",
      leaseTypes: ["short_term", "month_to_month"],
    });
  });

  it("resets everything a query did not mention", () => {
    expect(browseStateFromChatFilters({}, BOUNDS)).toEqual({
      moveIn: "",
      moveOut: "",
      budgetMin: 500,
      budgetMax: 6500,
      roomType: "any",
      bathroom: "any",
      petsOnly: false,
      neighborhood: undefined,
      leaseTypes: [],
    });
  });
});

describe("describeChatFilters", () => {
  it("lists the applied filters as plain facts with the home count", () => {
    expect(
      describeChatFilters(
        { bathroom: "private", maxBudget: 1200, petFriendly: true, leaseTypes: ["short_term"], neighborhood: "University District" },
        3,
      ).join(" · "),
    ).toBe("Private bath · under $1,200 · Pets · Short-term · University District · 3 homes");
  });
});

describe("ResidentHousingChat inline", () => {
  function ask(text: string) {
    const onApply = vi.fn();
    render(<ResidentHousingChat variant="inline" onApplyFilters={onApply} showMatchListings={false} />);
    fireEvent.change(screen.getByLabelText("Describe the home you're looking for"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    return onApply;
  }

  it("applies the filters, keeps the sentence and renders the Understood row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          filters: { bathroom: "private", maxBudget: 1200, petFriendly: true, neighborhood: "University District" },
          matchCount: 1,
          listings: [],
        }),
      }),
    );
    const onApply = ask("private bath under $1,200 near UW, pets");
    await waitFor(() => expect(screen.getByText("Understood")).toBeTruthy());
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ petFriendly: true, neighborhood: "University District" }));
    expect(screen.getByText("Private bath · under $1,200 · Pets · University District · 1 home")).toBeTruthy();
    expect((screen.getByLabelText("Describe the home you're looking for") as HTMLInputElement).value).toBe(
      "private bath under $1,200 near UW, pets",
    );
  });

  it("shows a 503 inline with a Retry action, and retry asks again", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: "The assistant isn't configured in this environment." }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ filters: {}, matchCount: 0, listings: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    const onApply = ask("anything");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("isn't configured");
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("the Ask inside the filter sheet", () => {
  it("survives the sheet's own apply button", async () => {
    // The Ask lives inside a DRAFTED panel: answering it has to move the drafts as well as
    // the page, or "Show N homes" commits the controls as they were before the question and
    // throws the answer away (lease type, budget floor and bedroom all reverted).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          filters: { minBudget: 1400, bedroom: "1", leaseTypes: ["short_term"], neighborhood: "Queen Anne" },
          matchCount: 1,
          listings: [],
        }),
      }),
    );
    render(<ResidentHousingBrowse />);
    fireEvent.click(document.querySelector('[data-attr="resident-browse-filter-open"]') as Element);
    fireEvent.change(await screen.findByLabelText("Describe the home you're looking for"), {
      target: { value: "short term room in Queen Anne, at least $1,400 a month" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(screen.getByText("Understood")).toBeTruthy());
    expect(screen.getByText("Clear filters (4)")).toBeTruthy();

    const apply = '[data-attr="resident-browse-filter-apply"], [data-attr="portal-filter-save"]';
    fireEvent.click(document.querySelector(apply) as Element);
    await waitFor(() => expect(screen.getByText("Clear filters (4)")).toBeTruthy());
  });
});
