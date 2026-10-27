// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { notifyResidentToursChanged } = vi.hoisted(() => ({
  notifyResidentToursChanged: vi.fn(),
}));

const { navigate, residentTourThreadHref } = vi.hoisted(() => ({
  navigate: vi.fn(),
  residentTourThreadHref: vi.fn(async (_base: string, id: string) => `/resident/communication/active/thread-for-${id}`),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("propertyId=property-1"),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("@/lib/resident-tour-thread-client", () => ({ residentTourThreadHref }));
vi.mock("@/lib/demo-property-pipeline", () => ({
  PROPERTY_PIPELINE_EVENT: "test:property-pipeline",
  loadPublicPropertyLeadFromServer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rental-application/data", () => ({
  getPropertyForPublicLink: () => ({ id: "property-1", title: "Tour home" }),
}));
vi.mock("@/lib/resident-tour-sync-client", () => ({ notifyResidentToursChanged }));
vi.mock("@/components/portal/portal-metrics", () => ({
  ManagerPortalPageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/portal/portal-data-table", () => ({ PORTAL_DATA_TABLE_WRAP: "" }));
vi.mock("@/components/marketing/tour-schedule-flow", () => ({
  TourScheduleFlow: ({ onSuccess, onMessageHost }: { onSuccess: () => void; onMessageHost?: (id: string) => void }) => (
    <>
      <button type="button" onClick={onSuccess}>Complete tour request</button>
      <button type="button" onClick={() => onMessageHost?.("inq-1")}>Message the host</button>
    </>
  ),
}));

import { ResidentTourScheduleClient } from "@/components/portal/resident-tour-schedule-client";

describe("ResidentTourScheduleClient", () => {
  afterEach(cleanup);
  beforeEach(() => {
    notifyResidentToursChanged.mockReset();
    navigate.mockReset();
  });

  it("the tour confirmation's Message the host opens the host-team thread, not a compose prefill", async () => {
    render(<ResidentTourScheduleClient />);
    fireEvent.click(screen.getByRole("button", { name: "Message the host" }));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/resident/communication/active/thread-for-inq-1"));
    expect(residentTourThreadHref).toHaveBeenCalledWith("/resident", "inq-1");
  });

  it("invalidates resident tour reads after the dedicated scheduling flow succeeds", () => {
    render(<ResidentTourScheduleClient />);
    fireEvent.click(screen.getByRole("button", { name: "Complete tour request" }));
    expect(notifyResidentToursChanged).toHaveBeenCalledTimes(1);
  });
});
