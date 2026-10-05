// @vitest-environment jsdom
/**
 * The manager's Move-in page: a tab per form the manager added (grouped by name, a form with no
 * copies included, a deleted form's copies still listed), no Inspections tab, one empty state when no
 * form exists; and the resident record's Move-in tab: every form of the property, by status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const getUser = () => import("@testing-library/user-event").then((m) => m.default);
import { ManagerMoveInFormsPage } from "@/components/portal/move-in-forms/manager-move-in-forms-panel";
import { ResidentRecordMoveInSection } from "@/components/portal/move-in-forms/resident-record-move-in-section";
import { newMoveInFormTemplate } from "@/lib/move-in-forms/templates";
import type { MoveInFormSummary, MoveInFormTemplate } from "@/lib/move-in-forms/types";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: nav.push, replace: nav.push, prefetch: vi.fn() }),
  usePathname: () => "/portal/move-in",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "u1", email: "ada@example.com", ready: true }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo/demo-session")>();
  return { ...actual, isDemoModeActive: () => false };
});
vi.mock("@/lib/workspaces/selection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspaces/selection")>();
  return { ...actual, workspaceContainsProperty: () => true };
});
vi.mock("@/components/providers/app-ui-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/providers/app-ui-provider")>();
  return { ...actual, useAppUi: () => ({ showToast: vi.fn() }), useConfirm: () => vi.fn().mockResolvedValue(true) };
});
const stored = vi.hoisted(() => ({ names: [] as string[], templates: [] as unknown[], extra: {} as Record<string, unknown>, peers: [] as unknown[] }));
vi.mock("@/lib/move-in-forms/manager-forms", () => ({ storedMoveInFormNames: () => stored.names }));
vi.mock("@/lib/manager-property-save-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-property-save-target")>();
  return { ...actual, resolveManagerListingSubmissionForPropertyId: () => ({ sub: { moveInFormTemplates: stored.templates, ...stored.extra }, saveTarget: { mode: "listing", saveId: "p1" } }) };
});
const rows = vi.hoisted(() => ({ approved: true }));
vi.mock("@/lib/manager-applications-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-applications-storage")>();
  return { ...actual, readManagerApplicationRows: () => [{ id: "app-1", bucket: rows.approved ? "approved" : "pending", withdrawnAt: null }, ...(stored.peers as never[])] };
});
const client = vi.hoisted(() => ({ loadMoveInForms: vi.fn(), sendMoveInForm: vi.fn() }));
vi.mock("@/lib/move-in-forms/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/move-in-forms/client")>();
  return { ...actual, ...client };
});

function copy(patch: Partial<MoveInFormSummary> = {}): MoveInFormSummary {
  return {
    id: "c1", applicationId: "app-1", managerUserId: "u1", propertyId: "p1", propertyLabel: "Brooklyn House", roomLabel: "Room 1",
    residentName: "Atlas Bailly", residentEmail: "atlas@example.com", formId: "t-key", formName: "Key receipt", source: "built",
    status: "sent", signedDocumentSha256: null, sentAt: "2026-10-01T17:00:00.000Z", dueAt: "2099-10-20T06:59:59.000Z",
    submittedAt: null, remindedAt: null, managerViewedAt: null, kind: "other", questionCount: 3, photoCount: 0, signed: false, ...patch,
  };
}

beforeEach(() => {
  stored.names = [];
  stored.templates = [];
  stored.extra = {};
  stored.peers = [];
  rows.approved = true;
  client.loadMoveInForms.mockResolvedValue({ forms: [], unread: 0 });
  client.sendMoveInForm.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("manager Move-in page", () => {
  it("shows one empty state when no form has been added anywhere, with an Add form button and no tabs", async () => {
    render(<ManagerMoveInFormsPage />);
    expect(await screen.findByText("No move-in forms yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add form" }));
    expect(nav.push).toHaveBeenCalledWith("/portal/properties/all");
    expect(document.querySelector('[data-attr^="move-in-forms-tab-"]')).toBeNull();
  });

  it("makes a tab per added form, alphabetical, including one nobody has been sent; no Inspections tab", async () => {
    stored.names = ["Pet agreement", "Intake form", "intake FORM "];
    client.loadMoveInForms.mockResolvedValue({ forms: [copy({ id: "a", formName: "Pet agreement", formId: "t-pet" })], unread: 0 });
    render(<ManagerMoveInFormsPage tab="pet-agreement" />);
    expect(await screen.findByText("Atlas Bailly · Pet agreement")).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll('[data-attr^="move-in-forms-tab-"]').length).toBe(2));
    expect(document.querySelector('[data-attr="move-in-forms-tab-intake-form"]')?.getAttribute("href")).toBe("/portal/move-in/intake-form");
    expect(document.querySelector('[data-attr="move-in-forms-tab-pet-agreement"]')?.textContent).toContain("Pet agreement");
    expect(screen.queryByText("Inspections")).toBeNull();
  });

  it("the bare address, and an unknown slug, show the first tab", async () => {
    stored.names = ["Key receipt", "Intake form"];
    client.loadMoveInForms.mockResolvedValue({
      forms: [copy({ id: "i", formName: "Intake form", formId: "t-in" }), copy({ id: "k", formName: "Key receipt" })],
      unread: 0,
    });
    render(<ManagerMoveInFormsPage />);
    expect(await screen.findByText("Atlas Bailly · Intake form")).toBeTruthy();
    expect(screen.queryByText("Atlas Bailly · Key receipt")).toBeNull();
    cleanup();
    render(<ManagerMoveInFormsPage tab="waiting" />);
    expect(await screen.findByText("Atlas Bailly · Intake form")).toBeTruthy();
  });

  it("a form with no copies lists nothing on its tab", async () => {
    stored.names = ["Intake form"];
    render(<ManagerMoveInFormsPage tab="intake-form" />);
    expect(await screen.findByText("Nothing sent yet")).toBeTruthy();
    expect(screen.queryAllByText(/Atlas Bailly/)).toHaveLength(0);
  });

  it("copies of one name across properties share the tab; a deleted form's copies keep their own", async () => {
    stored.names = ["Key receipt"];
    client.loadMoveInForms.mockResolvedValue({
      forms: [
        copy({ id: "a", propertyId: "p1", propertyLabel: "Brooklyn House" }),
        copy({ id: "b", propertyId: "p2", propertyLabel: "Alder House", formName: "key RECEIPT", residentName: "Maya Chen" }),
        copy({ id: "d", formId: "gone", formName: "Roof access", residentName: "Noor Ali" }),
        copy({ id: "x", formName: "Key receipt", status: "cancelled" }),
      ],
      unread: 0,
    });
    render(<ManagerMoveInFormsPage tab="key-receipt" />);
    expect(await screen.findByText("Atlas Bailly · Key receipt")).toBeTruthy();
    expect(screen.getByText("Maya Chen · key RECEIPT")).toBeTruthy();
    expect(screen.queryByText(/Noor Ali/)).toBeNull();
    cleanup();
    render(<ManagerMoveInFormsPage tab="roof-access" />);
    expect(await screen.findByText("Noor Ali · Roof access")).toBeTruthy();
  });
});

describe("resident record › Move-in", () => {
  const template = (id: string, name: string): MoveInFormTemplate => ({ ...newMoveInFormTemplate("built"), id, name });
  const section = () => (
    <ResidentRecordMoveInSection userId="u1" applicationId="app-1" residentName="Atlas Bailly" residentEmail="atlas@example.com" propertyId="p1" initialSubTab="forms" />
  );

  it("lists every form of the property: Not sent, Sent with its due date, Submitted", async () => {
    stored.templates = [template("t-intake", "Intake form"), template("t-key", "Key receipt"), template("t-pet", "Pet agreement")];
    client.loadMoveInForms.mockResolvedValue({
      forms: [
        copy({ id: "k", formId: "t-key", formName: "Key receipt" }),
        copy({ id: "p", formId: "t-pet", formName: "Pet agreement", status: "submitted", submittedAt: "2026-10-02T20:00:00.000Z" }),
      ],
      unread: 0,
    });
    render(section());
    const rowFor = async (name: string) => (await screen.findAllByText(name)).map((el) => el.closest('[data-attr="resident-move-in-form-row"]')).find(Boolean) as HTMLElement;
    expect(within(await rowFor("Intake form")).getByText("Not sent")).toBeTruthy();
    expect(within(await rowFor("Key receipt")).getByText(/Due Oct 19/)).toBeTruthy();
    expect(within(await rowFor("Pet agreement")).getByText("Submitted Oct 2")).toBeTruthy();
  });

  it("a Not sent row sends that form for this resident's residency", async () => {
    stored.templates = [template("t-intake", "Intake form")];
    render(section());
    const user = await getUser();
    await act(async () => {
      await user.click(await screen.findByRole("button", { name: "Actions for Intake form" }));
    });
    await act(async () => {
      await user.click(await screen.findByRole("menuitem", { name: "Send" }));
    });
    await waitFor(() => expect(client.sendMoveInForm).toHaveBeenCalledWith({ applicationId: "app-1", formId: "t-intake" }));
  });

  it("Send is disabled until the application is approved", async () => {
    rows.approved = false;
    stored.templates = [template("t-intake", "Intake form")];
    render(section());
    const user = await getUser();
    await act(async () => {
      await user.click(await screen.findByRole("button", { name: "Actions for Intake form" }));
    });
    const send = await screen.findByRole("menuitem", { name: "Send" });
    expect(send.getAttribute("aria-disabled") === "true" || send.hasAttribute("data-disabled") || send.hasAttribute("disabled")).toBe(true);
    expect(client.sendMoveInForm).not.toHaveBeenCalled();
  });

  it("a property with no forms says so and links to its Forms", async () => {
    render(section());
    expect(await screen.findByText("No move-in forms for this property")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Forms" }));
    expect(nav.push).toHaveBeenCalledWith("/portal/properties/all/p1/move-in");
  });

  it("opens on Move-in info with the property's instructions, access and Wi-Fi, and Edit in property", async () => {
    stored.extra = {
      v: 1,
      houseMoveInInstructions: "Front door code is on the fridge.",
      houseInfo: { access: { doorCode: "4321" }, wifi: { network: "BrooklynNet", password: "hunter22" } },
      amenitiesText: "Washer\nPatio",
    };
    render(<ResidentRecordMoveInSection userId="u1" applicationId="app-1" residentName="Atlas Bailly" residentEmail="atlas@example.com" propertyId="p1" propertyHref="/portal/properties/all/p1/move-in" />);
    expect(await screen.findByText("Move-in details Atlas received")).toBeTruthy();
    expect(screen.getByText("Front door code is on the fridge.")).toBeTruthy();
    expect(screen.getByText("Patio")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit in property" }));
    expect(nav.push).toHaveBeenCalledWith("/portal/properties/all/p1/move-in");
  });

  it("House rules says so when the property has none, and shows rules text when it does", async () => {
    render(<ResidentRecordMoveInSection userId="u1" applicationId="app-1" residentName="Atlas Bailly" residentEmail="atlas@example.com" propertyId="p1" initialSubTab="rules" houseDetailsHref="/portal/properties/all/p1/house" />);
    expect(await screen.findByText("No house rules on this property yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add in property" }));
    expect(nav.push).toHaveBeenCalledWith("/portal/properties/all/p1/house");
    cleanup();
    stored.extra = { v: 1, houseRulesText: "Quiet after 10pm." };
    render(<ResidentRecordMoveInSection userId="u1" applicationId="app-1" residentName="Atlas Bailly" residentEmail="atlas@example.com" propertyId="p1" initialSubTab="rules" />);
    expect(await screen.findByText("Quiet after 10pm.")).toBeTruthy();
  });

  // A roommate is somebody who actually lives there: `residentDirectoryStage`'s "current".
  // An approved application nobody has signed is still only a potential resident, and a tenancy
  // whose move-out date has passed is over — neither is a roommate.
  it("Roommates lists only the current residents at the property and opens one", async () => {
    stored.peers = [
      { id: "app-2", name: "Maya Chen", bucket: "approved", propertyId: "p1", withdrawnAt: null, manuallyAdded: true, manualResidentDetails: { roomNumber: "Room 2", moveInDate: "2020-01-01" } },
      { id: "app-3", name: "Elsewhere Person", bucket: "approved", propertyId: "p9", withdrawnAt: null, manuallyAdded: true },
      { id: "app-4", name: "Pending Person", bucket: "pending", propertyId: "p1", withdrawnAt: null },
      { id: "app-5", name: "Unsigned Person", bucket: "approved", propertyId: "p1", withdrawnAt: null, manualResidentDetails: { roomNumber: "Room 5", moveInDate: "2020-01-01" } },
      { id: "app-6", name: "Moved Out Person", bucket: "approved", propertyId: "p1", withdrawnAt: null, manuallyAdded: true, manualResidentDetails: { roomNumber: "Room 6", moveInDate: "2020-01-01", moveOutDate: "2020-06-01" } },
      { id: "app-7", name: "Signed Person", bucket: "approved", propertyId: "p1", withdrawnAt: null, manualResidentDetails: { roomNumber: "Room 7", moveInDate: "2020-01-01" } },
    ];
    const open = vi.fn();
    render(<ResidentRecordMoveInSection userId="u1" applicationId="app-1" residentName="Atlas Bailly" residentEmail="atlas@example.com" propertyId="p1" initialSubTab="roommates" onOpenResident={open} leaseExecuted={(row) => row.id === "app-7"} />);
    fireEvent.click(await screen.findByText("Maya Chen"));
    expect(open).toHaveBeenCalledWith("app-2");
    expect(screen.getByText("Signed Person")).toBeTruthy();
    expect(screen.queryByText("Elsewhere Person")).toBeNull();
    expect(screen.queryByText("Pending Person")).toBeNull();
    expect(screen.queryByText("Unsigned Person")).toBeNull();
    expect(screen.queryByText("Moved Out Person")).toBeNull();
    cleanup();
    stored.peers = [];
    render(<ResidentRecordMoveInSection userId="u1" applicationId="app-1" residentName="Atlas Bailly" residentEmail="atlas@example.com" propertyId="p1" initialSubTab="roommates" />);
    expect(await screen.findByText("No roommates at this property yet")).toBeTruthy();
  });

  it("Forms carries the Inspections card and an Add inspection action", async () => {
    const add = vi.fn();
    render(<ResidentRecordMoveInSection userId="u1" applicationId="app-1" residentName="Atlas Bailly" residentEmail="atlas@example.com" propertyId="p1" initialSubTab="forms" inspectionsPanel={<p>Inspection list</p>} onAddInspection={add} />);
    expect(await screen.findByText("Inspection list")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add inspection" }));
    expect(add).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Roommates"));
    expect(await screen.findByText("No roommates at this property yet")).toBeTruthy();
  });
});
