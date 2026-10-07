// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("@/components/portal/workspace-provider", () => ({
  useWorkspaces: () => ({ workspaces: [], active: { id: "w1", name: "Seattle", propertyIds: [], propertyLabels: {} } }),
}));

import { ManagerMessageChannelsPanel, formatWorkNumber } from "@/components/portal/integrations-messages-panel";
import { resetSharedGets } from "@/lib/shared-get-cache";

const emailStatus = (address: string | null, canUse = true) => ({
  provisioningAvailable: true, sendingAvailable: true, receivingAvailable: true, storageReady: true, planTier: "paid",
  entitlement: { eligible: true, tier: "business", source: "stripe" }, workspaceRole: "primary", workspaceEmail: null,
  address, state: "ready", canRequest: false, canUse,
});

function stubFetch(number: string | null, email: ReturnType<typeof emailStatus>) {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (url.includes("messaging-number") ? { number: number ? { phoneNumber: number } : null } : email),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  resetSharedGets();
  cleanup();
  vi.unstubAllGlobals();
});

describe("Integrations → Messages", () => {
  it("formats a US work number", () => {
    expect(formatWorkNumber("+12065550001")).toBe("(206) 555-0001");
    expect(formatWorkNumber("not a number")).toBe("not a number");
  });

  it("shows the work number and work email for the active workspace", async () => {
    const fetchMock = stubFetch("+12065550001", emailStatus("seattle@mail.proplane.ai"));
    render(<ManagerMessageChannelsPanel />);
    await waitFor(() => expect(document.querySelector('[data-attr="settings-messages-number"]')?.textContent).toBe("(206) 555-0001"));
    expect(document.querySelector('[data-attr="settings-messages-email"]')?.textContent).toBe("seattle@mail.proplane.ai");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/manager/messaging-number?workspaceId=w1", "/api/manager/assistant-email?workspaceId=w1"]);
  });

  it("says Not set up for a channel the workspace does not have, and an email that cannot carry mail", async () => {
    stubFetch(null, emailStatus("x@mail.proplane.ai", false));
    render(<ManagerMessageChannelsPanel />);
    await waitFor(() => expect(document.querySelector('[data-attr="settings-messages-number"]')?.textContent).toBe("Not set up"));
    expect(document.querySelector('[data-attr="settings-messages-email"]')?.textContent).toBe("Not set up");
  });

  it("is read-only: Manage on either row opens Communication settings, and nothing else is editable", async () => {
    stubFetch("+12065550001", emailStatus(null));
    const onManage = vi.fn();
    render(<ManagerMessageChannelsPanel onManage={onManage} />);
    fireEvent.click(document.querySelector('[data-attr="settings-messages-number-manage"]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-attr="settings-messages-email-manage"]') as HTMLElement);
    expect(onManage).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll("input, textarea, select").length).toBe(0);
  });
});
