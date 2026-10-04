// @vitest-environment jsdom
//
// One header for both kinds of service (plan D8, option A): Message · Edit · ⋯ · the next step as the ONE
// labeled primary. The label follows the status: Approve, then Mark done, nothing once it is finished.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ADD_ON_NEXT_STEP_LABEL, addOnHeaderNextStep, serviceHeaderMenuItems } from "@/lib/service-header-next-step";
import type { ServiceRequest } from "@/lib/service-requests-storage";

vi.mock("@/hooks/use-work-assignment-directory", () => ({
  useWorkAssignmentDirectory: () => ({ teamMembers: [], vendors: [] }),
}));

afterEach(() => cleanup());

const req = (status: ServiceRequest["status"]): ServiceRequest => ({
  id: "SR-1", offerId: "storage", offerName: "Storage locker", offerDescription: "", price: "$40", deposit: "", residentEmail: "liam@example.com",
  residentName: "Liam Foster", managerUserId: "mgr-1", propertyId: "prop-a", returnByDate: "", notes: "", requestedAt: "2026-10-02T00:00:00.000Z",
  status, servicePaid: false, depositPaid: false,
});

describe("the header's next step", () => {
  it("is Approve while pending, Mark done once approved, and nothing once returned or declined", () => {
    expect(addOnHeaderNextStep({ status: "pending" })).toEqual({ key: "approve", label: "Approve" });
    expect(addOnHeaderNextStep({ status: "approved" })).toEqual({ key: "mark-done", label: "Mark done" });
    expect(addOnHeaderNextStep({ status: "returned" })).toBeNull();
    expect(addOnHeaderNextStep({ status: "denied" })).toBeNull();
    expect(ADD_ON_NEXT_STEP_LABEL).toEqual({ approve: "Approve", "mark-done": "Mark done" });
  });

  it("the ⋯ holds Decline request (add-on, pending) or Cancel service (maintenance) with Delete - all red", () => {
    expect(serviceHeaderMenuItems("add-on", { canDecline: true }).map((i) => i.label)).toEqual(["Decline request", "Delete"]);
    expect(serviceHeaderMenuItems("add-on", { canDecline: false }).map((i) => i.label)).toEqual(["Delete"]);
    expect(serviceHeaderMenuItems("maintenance", { canCancel: true }).map((i) => i.label)).toEqual(["Cancel service", "Delete"]);
    expect(serviceHeaderMenuItems("maintenance", { canCancel: false, canDelete: true }).map((i) => i.label)).toEqual(["Delete"]);
    expect(serviceHeaderMenuItems("add-on", { canDecline: true, canDelete: false }).map((i) => i.label)).toEqual(["Decline request"]);
    for (const item of serviceHeaderMenuItems("add-on", { canDecline: true })) expect(item.danger).toBe(true);
  });
});

describe("an add-on's header, rendered", () => {
  const renderHeader = async (status: ServiceRequest["status"]) => {
    const { AppUiProvider } = await import("@/components/providers/app-ui-provider");
    const { ManagerServiceRequestDetail } = await import("@/components/portal/pro-service-request-detail");
    return render(
      <AppUiProvider>
        <ManagerServiceRequestDetail req={req(status)} onUpdated={vi.fn()} onMessage={vi.fn()} actionsOnly />
      </AppUiProvider>,
    );
  };
  const headerControls = () =>
    [...document.querySelectorAll('[data-attr="service-request-header-icons"] button')]
      .filter((b) => !b.closest("[inert]"))
      .map((b) => b.getAttribute("aria-label"));

  it("pending: Message, Edit, ⋯, then Approve as the one button with a word on it; the inline price pencil is gone", async () => {
    await renderHeader("pending");
    expect(headerControls()).toEqual(["Message", "Edit", "More", "Approve"]);
    const primary = document.querySelector('[data-attr="service-request-approve"]')!;
    expect(primary.textContent).toBe("Approve");
    expect(document.querySelector('[data-attr="service-request-edit-charges"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    fireEvent.keyDown(document.querySelector('[data-attr="record-header-action-more"]')!, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu");
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent)).toEqual(["Decline request", "Delete"]);
    for (const item of menu.querySelectorAll('[role="menuitem"]')) expect(item.className).toMatch(/text-red-600/);
  });

  it("Decline request in the menu opens the existing reason dialog", async () => {
    await renderHeader("pending");
    fireEvent.keyDown(document.querySelector('[data-attr="record-header-action-more"]')!, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Decline request" }));
    expect(await screen.findByRole("heading", { name: "Decline request" })).toBeInTheDocument();
    expect(document.querySelector('[data-attr="service-request-deny-reason"]')).not.toBeNull();
  });

  it("approved: the primary is Mark done and the menu drops Decline", async () => {
    await renderHeader("approved");
    expect(headerControls()).toEqual(["Message", "Edit", "More", "Mark done"]);
    fireEvent.keyDown(document.querySelector('[data-attr="record-header-action-more"]')!, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu");
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent)).toEqual(["Delete"]);
  });

  it.each(["returned", "denied"] as const)("%s: no primary at all", async (status) => {
    await renderHeader(status);
    expect(headerControls()).not.toContain("Approve");
    expect(headerControls()).not.toContain("Mark done");
    expect(document.querySelector('[data-attr="service-request-approve"]')).toBeNull();
    expect(document.querySelector('[data-attr="service-request-mark-done"]')).toBeNull();
  });
});
