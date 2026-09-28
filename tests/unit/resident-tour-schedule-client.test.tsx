// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { notifyResidentToursChanged } = vi.hoisted(() => ({
  notifyResidentToursChanged: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("propertyId=property-1"),
}));
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
  TourScheduleFlow: ({ onSuccess }: { onSuccess: () => void }) => (
    <button type="button" onClick={onSuccess}>Complete tour request</button>
  ),
}));

import { ResidentTourScheduleClient } from "@/components/portal/resident-tour-schedule-client";

describe("ResidentTourScheduleClient", () => {
  beforeEach(() => notifyResidentToursChanged.mockReset());

  it("invalidates resident tour reads after the dedicated scheduling flow succeeds", () => {
    render(<ResidentTourScheduleClient />);
    fireEvent.click(screen.getByRole("button", { name: "Complete tour request" }));
    expect(notifyResidentToursChanged).toHaveBeenCalledTimes(1);
  });
});
