// @vitest-environment jsdom
/**
 * Covers the Part 2 redraw of `ManagerReminderRuleSettingsPanel`: audience
 * rows are always visible (no mode selector hiding them first), an audience
 * a kind cannot notify renders locked with a real reason rather than
 * silently missing, `tour_interest`'s dispatcher-fixed fields render locked
 * with the declared reason, and the inbox channel can never be switched off.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fixedRuleFields } from "@/lib/reminders/fixed-rule-fields";

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),
  useAppUi: () => ({ showToast }),
}));

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import { ManagerReminderRuleSettingsPanel } from "@/components/portal/manager-reminder-rule-settings";

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/portal/reminder-settings")) {
        if (init?.method === "PATCH") return Response.json({ settings: {} });
        return Response.json({ settings: {} });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  showToast.mockClear();
});

describe("ManagerReminderRuleSettingsPanel audience rows", () => {
  it("shows every supported audience row without first choosing a mode", async () => {
    stubFetch();
    render(<ManagerReminderRuleSettingsPanel kind="work_order" audienceMode="both" teamMembers={[]} />);

    // Both "You" and "Resident & vendor" (audienceMode="both") are visible immediately —
    // no "Reminder type" mode picker to click through first.
    expect(await screen.findByText("You")).toBeTruthy();
    expect(screen.getByText("Resident & vendor")).toBeTruthy();
    expect(screen.queryByText(/reminder type/i)).toBeNull();
  });

  it("locks an audience a kind cannot notify, with a real reason, instead of hiding the row", async () => {
    stubFetch();
    render(
      <ManagerReminderRuleSettingsPanel
        kind="inspection_manager"
        audienceMode="manager"
        teamMembers={[{ userId: "u1" }, { userId: "u2" }]}
      />,
    );

    // "Resident" (the counterparty) is not supported for inspection_manager — it must still
    // render, locked, with a real explanation, never silently absent.
    const lockedLabel = await screen.findByText("Resident");
    const lockedRow = lockedLabel.closest("div");
    expect(lockedRow?.textContent).toMatch(/never notified/i);

    // Manager and team ARE supported for this kind and must render as live controls.
    expect(screen.getByRole("switch", { name: "Notify You" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Notify Team" })).toBeTruthy();
  });

  it("locks the team audience with a reason when there are no co-managers to notify", async () => {
    stubFetch();
    render(<ManagerReminderRuleSettingsPanel kind="work_order" audienceMode="both" teamMembers={[]} />);

    const teamLabel = await screen.findByText("Team");
    expect(teamLabel.closest("div")?.textContent).toMatch(/co-manager/i);
  });

  it("renders tour_interest's dispatcher-fixed fields locked, carrying the declared reason", async () => {
    stubFetch();
    render(<ManagerReminderRuleSettingsPanel kind="tour_interest" audienceMode="counterparty" teamMembers={[]} />);

    const fixed = fixedRuleFields("tour_interest");
    expect(fixed).not.toBeNull();

    // tour_interest ships disabled by default — turn the rule on so its (fixed)
    // timing/audience/channel rows render at all, same as the pre-existing gate.
    await userEvent.click(await screen.findByRole("switch", { name: "Send reminders" }));

    const matches = await screen.findAllByText(fixed!.reason);
    // timings, audience ("Who's notified"), and channels are all fixed for this kind —
    // each renders its own locked row carrying the same declared reason.
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("never lets the inbox channel be switched off", async () => {
    stubFetch();
    render(<ManagerReminderRuleSettingsPanel kind="work_order" audienceMode="both" teamMembers={[]} />);

    await screen.findByText("You");
    const inboxCells = screen.getAllByRole("switch", { name: "Inbox" });
    expect(inboxCells.length).toBeGreaterThan(0);
    for (const cell of inboxCells) {
      expect(cell.getAttribute("aria-checked")).toBe("true");
      expect(cell).toBeDisabled();
    }

    // Clicking a disabled control is a no-op, but assert the state explicitly rather than
    // just trusting `disabled` — this is the guarantee the row exists to make.
    await userEvent.click(inboxCells[0]!);
    expect(inboxCells[0]!.getAttribute("aria-checked")).toBe("true");
  });

  it("gives every settings row a real consequence line, not just its label", async () => {
    stubFetch();
    render(<ManagerReminderRuleSettingsPanel kind="work_order" audienceMode="both" teamMembers={[]} />);

    const youLabel = await screen.findByText("You");
    const youRow = youLabel.closest("div");
    expect(youRow?.textContent).toMatch(/notifies you/i);
    expect(youRow?.textContent).not.toBe("You");

    const enabledMeta = await screen.findByText(
      "Turns this reminder on or off. Every setting below is ignored while it's off.",
    );
    expect(enabledMeta).toBeTruthy();
  });
});
