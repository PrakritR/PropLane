// @vitest-environment jsdom
/**
 * Regression for the shared-channels defect: the channel control used to be
 * rendered once per audience row (You / Team / Resident), all
 * three bound to the same `rule.email` / `rule.sms` state — so clicking
 * "You → Text" silently also flipped "Resident → Text" because there was
 * never more than one value to begin with. The channels are per-RULE, not
 * per-audience (`rules.ts`), so the control must render exactly once.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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

const teamMembers = [{ userId: "u1" }, { userId: "u2" }];

function renderPanel() {
  return render(
    <ManagerReminderRuleSettingsPanel kind="work_order" audienceMode="both" teamMembers={teamMembers} />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  showToast.mockClear();
});

describe("ManagerReminderRuleSettingsPanel channels are rule-wide", () => {
  it("renders the channel controls once for the rule, not once per audience row", async () => {
    stubFetch();
    renderPanel();

    // All three audience rows are live for this kind/mode — confirm they are
    // actually on screen before asserting the channel group is not duplicated
    // alongside them.
    await screen.findByText("You");
    expect(screen.getByText("Team")).toBeTruthy();
    expect(screen.getByText("Resident")).toBeTruthy();

    // One "Send via" dropdown for the whole rule, in its own row under the
    // audience list — not one per audience row.
    expect(screen.getAllByRole("button", { name: "Send via" })).toHaveLength(1);
    expect(screen.getByText("Send via")).toBeTruthy();
  });

  it("toggling the shared channel changes the rule's single value and no second control claims a different state", async () => {
    stubFetch();
    renderPanel();

    await screen.findByText("You");
    fireEvent.click(screen.getByRole("button", { name: "Send via", expanded: false }));
    const listbox = screen.getByRole("listbox", { name: "Send via" });
    const text = within(listbox).getByRole("option", { name: "Text" });
    expect(text.getAttribute("aria-selected")).toBe("false");

    fireEvent.pointerDown(text, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(text, { pointerId: 1, clientX: 10, clientY: 10 });

    // Still exactly one Text option, and it reflects the new value — there is
    // no second, stale control left showing the old state.
    const listboxes = screen.getAllByRole("listbox", { name: "Send via" });
    expect(listboxes).toHaveLength(1);
    expect(within(listboxes[0]!).getByRole("option", { name: "Text" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Send via" }).textContent).toContain("Text");
  });

  it("never lets the inbox channel be switched off", async () => {
    stubFetch();
    renderPanel();

    await screen.findByText("You");
    fireEvent.click(screen.getByRole("button", { name: "Send via", expanded: false }));
    const listbox = screen.getByRole("listbox", { name: "Send via" });
    const inbox = within(listbox).getByRole("option", { name: "Inbox" });
    expect(inbox.getAttribute("aria-selected")).toBe("true");
    expect(inbox.getAttribute("aria-disabled")).toBe("true");

    fireEvent.pointerDown(inbox, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(inbox, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(within(listbox).getByRole("option", { name: "Inbox" }).getAttribute("aria-selected")).toBe("true");
  });
});
