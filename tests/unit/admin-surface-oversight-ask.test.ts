// @vitest-environment jsdom
/**
 * The admin Communication surface reaches manager routes that this release tightened to a stored
 * `manager` row, widened only when the request ASKS for admin oversight. A seated Overall admin
 * holds the stored `admin` row and no manager row, so every one of those calls 401s without the
 * ask — the thread pane's Schedule send is the loudest ("Unauthorized." on the toast), the
 * Scheduled read the quietest (the decoration and its cancel affordance just vanish).
 *
 * This pins the behaviour end to end: under `/admin` the ask is on the wire, and under `/portal` the
 * very same helpers are byte-identical, so a manager's own sends are untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

import {
  sendAutomationScheduledMessageNow,
  sendManualScheduledMessageNow,
} from "@/components/portal/portal-inbox-selection";

function at(pathname: string) {
  window.history.replaceState({}, "", pathname);
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  at("/");
});

/** Every URL the call under test sent, in order. */
const urls = () => fetchMock.mock.calls.map((call) => String(call[0]));

describe("the shared send-now helpers ask for oversight on the admin surface", () => {
  it("appends oversight=admin under /admin", async () => {
    at("/admin/communication/active/thread-1");

    await sendManualScheduledMessageNow("m1");
    await sendAutomationScheduledMessageNow("charge-1");

    expect(urls()[0]).toBe("/api/portal/scheduled-inbox-messages/m1/send-now?oversight=admin");
    expect(urls()[1]).toContain("oversight=admin");
    expect(urls()[1]).toContain("/api/portal/scheduled-messages/");
  });

  it("keeps an existing query string and adds the ask beside it", async () => {
    at("/admin/communication");

    await sendManualScheduledMessageNow("m1", { asResident: true });

    expect(urls()[0]).toBe("/api/portal/scheduled-inbox-messages/m1/send-now?as=resident&oversight=admin");
  });

  it("adds nothing on the manager portal, so a manager's own send is unchanged", async () => {
    at("/portal/communication/active/thread-1");

    await sendManualScheduledMessageNow("m1");
    await sendAutomationScheduledMessageNow("charge-1");

    for (const url of urls()) expect(url).not.toContain("oversight");
    expect(urls()[0]).toBe("/api/portal/scheduled-inbox-messages/m1/send-now");
  });

  it("adds nothing on a path that merely starts with the admin letters", async () => {
    at("/administration/communication");

    await sendManualScheduledMessageNow("m1");

    expect(urls()[0]).not.toContain("oversight");
  });
});
