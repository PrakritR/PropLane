// @vitest-environment jsdom
//
// Edit opens the standard popup (the New property shell) with Service · Home · Price · Schedule, for an
// add-on and a maintenance service alike, and saves through the writes the old edit dialogs used.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { ServiceRequest } from "@/lib/service-requests-storage";

const writes = vi.hoisted(() => ({ updateServiceRequest: vi.fn(), updateManagerWorkOrder: vi.fn() }));
vi.mock("@/lib/service-requests-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateServiceRequest: writes.updateServiceRequest,
}));
vi.mock("@/lib/manager-work-orders-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateManagerWorkOrder: writes.updateManagerWorkOrder,
}));
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncPropertyPipelineFromServer: async () => undefined,
}));
vi.mock("@/lib/manager-applications-storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncManagerApplicationsFromServer: async () => [],
}));

import {
  addOnEditUpdates,
  applyWorkOrderEdit,
  serviceEditDraftFor,
  toDatetimeLocal,
} from "@/components/portal/service-edit-popup";

const addOn: ServiceRequest = {
  id: "SR-1", offerId: "storage", offerName: "Storage locker", offerDescription: "Basement locker", price: "$40", deposit: "$50",
  residentEmail: "liam@example.com", residentName: "Liam Foster", managerUserId: "mgr-1", propertyId: "prop-a", returnByDate: "2026-12-01",
  notes: "", requestedAt: "2026-10-02T00:00:00.000Z", status: "pending", servicePaid: false, depositPaid: false,
};
const workOrder: DemoManagerWorkOrderRow = {
  id: "wo-1", propertyName: "Alder House", unit: "2B", title: "Burst pipe", priority: "High", status: "Open", bucket: "open", description: "Under the sink",
  scheduled: "", cost: "$120", propertyId: "prop-a", residentEmail: "maya@example.com", residentName: "Maya Chen", preferredArrival: "After 5pm",
};

beforeEach(() => {
  writes.updateServiceRequest.mockClear();
  writes.updateManagerWorkOrder.mockClear();
});
afterEach(() => cleanup());

describe("the draft a service opens with", () => {
  it("reads an add-on's name, details, home, price, deposit and return date", () => {
    expect(serviceEditDraftFor({ kind: "add-on", request: addOn })).toMatchObject({
      title: "Storage locker", details: "Basement locker", propertyId: "prop-a", residentEmail: "liam@example.com", price: "40", deposit: "50", returnBy: "2026-12-01",
    });
  });

  it("reads a maintenance service's title, priority, cost, arrival and room", () => {
    expect(serviceEditDraftFor({ kind: "maintenance", row: { ...workOrder, assignedRoomChoice: "r1" } })).toMatchObject({
      title: "Burst pipe", priority: "High", cost: "$120", preferredArrival: "After 5pm", roomChoice: "r1", propertyId: "prop-a",
    });
  });
});

describe("what a save writes", () => {
  it("an add-on goes through updateServiceRequest with the fee, deposit, home and visit", () => {
    const draft = { ...serviceEditDraftFor({ kind: "add-on", request: addOn }), title: " Storage unit ", price: "55", visit: toDatetimeLocal("2026-10-08T16:00:00.000Z") };
    const updates = addOnEditUpdates(draft, { propertyId: "prop-b", residentName: "Liam Foster", hasDeposit: true });
    expect(updates).toMatchObject({ offerName: "Storage unit", price: "55", deposit: "50", propertyId: "prop-b", returnByDate: "2026-12-01", residentEmail: "liam@example.com" });
    expect(updates.proposedVisit?.iso).toBe(new Date(draft.visit).toISOString());
    // No deposit, no return date.
    expect(addOnEditUpdates({ ...draft, deposit: "" }, { propertyId: "prop-a", residentName: "Liam", hasDeposit: false }).returnByDate).toBe("");
  });

  it("a maintenance row changes only what the popup edits, and a vendor-fixed cost stays", () => {
    const draft = { ...serviceEditDraftFor({ kind: "maintenance", row: workOrder }), title: "Burst pipe (kitchen)", cost: "$999", priority: "Emergency" };
    const next = applyWorkOrderEdit(workOrder, draft, { propertyLabel: "Alder House", residentName: "Maya Chen", costLocked: false });
    expect(next).toMatchObject({ id: "wo-1", title: "Burst pipe (kitchen)", cost: "$999", priority: "Emergency", status: "Open", bucket: "open" });
    const locked = applyWorkOrderEdit(workOrder, draft, { propertyLabel: "Alder House", residentName: "Maya Chen", costLocked: true });
    expect(locked.cost).toBe("$120");
    const moved = applyWorkOrderEdit(workOrder, { ...draft, propertyId: "prop-b" }, { propertyLabel: "Birch House", residentName: "Maya Chen", costLocked: false });
    expect(moved).toMatchObject({ propertyId: "prop-b", propertyName: "Birch House" });
  });
});

describe("the popup", () => {
  const renderPopup = async (target: Parameters<typeof import("@/components/portal/service-edit-popup").ServiceEditPopup>[0]["target"]) => {
    const { AppUiProvider } = await import("@/components/providers/app-ui-provider");
    const { ServiceEditPopup } = await import("@/components/portal/service-edit-popup");
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(
      <AppUiProvider>
        <ServiceEditPopup open target={target} managerUserId="mgr-1" onClose={onClose} onSaved={onSaved} />
      </AppUiProvider>,
    );
    return { onClose, onSaved };
  };

  it("is the standard popup with the steps Service, Home, Price, Schedule", async () => {
    await renderPopup({ kind: "add-on", request: addOn });
    const rail = await screen.findAllByText(/^(Service|Home|Price|Schedule)$/);
    expect(new Set(rail.map((el) => el.textContent))).toEqual(new Set(["Service", "Home", "Price", "Schedule"]));
    expect(screen.getByRole("dialog", { name: "Edit service" })).toBeTruthy();
    expect((document.querySelector('[data-attr="service-edit-title"]') as HTMLInputElement).value).toBe("Storage locker");
  });

  it("walks to the last step and saves an add-on through updateServiceRequest", async () => {
    const { onClose, onSaved } = await renderPopup({ kind: "add-on", request: addOn });
    const title = (await screen.findByDisplayValue("Storage locker")) as HTMLInputElement;
    fireEvent.change(title, { target: { value: "Storage unit" } });
    for (const step of ["Home", "Price", "Schedule"]) {
      fireEvent.click(screen.getAllByRole("button", { name: new RegExp(`^${step}`) })[0]!);
    }
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(writes.updateServiceRequest).toHaveBeenCalledTimes(1));
    expect(writes.updateServiceRequest.mock.calls[0]![0]).toBe("SR-1");
    expect(writes.updateServiceRequest.mock.calls[0]![1]).toMatchObject({ offerName: "Storage unit", price: "40" });
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
