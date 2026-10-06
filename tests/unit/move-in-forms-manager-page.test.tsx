// @vitest-environment jsdom
/**
 * The manager's Forms page (sidebar, TENANCY): every form sent to a resident, Pending (sent) and
 * Completed (submitted) tabs with counts, search, a multi-select Filter (Kind, Property, Resident, Blocks),
 * rows with the ⋯ leaves (Edit · Remind · Cancel request, or View · Download PDF) and no pill; and the resident
 * record's Forms tab, the same list scoped to one resident.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FormsList, ManagerFormsPage } from "@/components/portal/move-in-forms/forms-list";
import type { MoveInFormSummary } from "@/lib/move-in-forms/types";

const getUser = () => import("@testing-library/user-event").then((m) => m.default);

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: nav.push, replace: nav.push, prefetch: vi.fn() }),
  usePathname: () => "/portal/forms",
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
const client = vi.hoisted(() => ({ loadMoveInForms: vi.fn(), remindMoveInForm: vi.fn(), getMoveInForm: vi.fn() }));
vi.mock("@/lib/move-in-forms/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/move-in-forms/client")>();
  return { ...actual, ...client };
});

function copy(patch: Partial<MoveInFormSummary> = {}): MoveInFormSummary {
  return {
    id: "c1", applicationId: "app-1", managerUserId: "u1", propertyId: "p1", propertyLabel: "Brooklyn House", roomLabel: "Room 1",
    residentName: "Atlas Bailly", residentEmail: "atlas@example.com", formId: "t-key", formName: "Key receipt", source: "built",
    status: "sent", signedDocumentSha256: null, sentAt: "2026-10-01T17:00:00.000Z", dueAt: "2099-10-20T06:59:59.000Z",
    submittedAt: null, remindedAt: null, managerViewedAt: null, kind: "other", blocks: "nothing", questionCount: 3, photoCount: 0, signed: false, ...patch,
  };
}

const FORMS = [
  copy({ id: "a", formName: "Resident intake", kind: "intake", blocks: "move_in_details" }),
  copy({ id: "b", formName: "Pet agreement", blocks: "lease_signing", residentName: "Maya Chen", applicationId: "app-2", propertyId: "p2", propertyLabel: "Alder Row" }),
  copy({ id: "c", formName: "Move-in checklist", kind: "move-in", status: "submitted", submittedAt: "2026-10-02T20:00:00.000Z" }),
  copy({ id: "x", formName: "Cancelled thing", status: "cancelled" }),
];

beforeEach(() => {
  client.loadMoveInForms.mockResolvedValue({ forms: FORMS, unread: 0 });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("manager Forms page", () => {
  it("lists Pending (sent) forms with a count per tab, never a cancelled one, and links each tab", async () => {
    render(<ManagerFormsPage />);
    expect(await screen.findByText("Resident intake")).toBeTruthy();
    expect(screen.getByText("Pet agreement")).toBeTruthy();
    expect(screen.queryByText("Move-in checklist")).toBeNull();
    expect(screen.queryByText("Cancelled thing")).toBeNull();
    const pending = document.querySelector('[data-attr="forms-tab-pending"]')!;
    const completed = document.querySelector('[data-attr="forms-tab-completed"]')!;
    expect(pending.textContent).toContain("2");
    expect(completed.textContent).toContain("1");
    expect(pending.getAttribute("href")).toBe("/portal/forms");
    expect(completed.getAttribute("href")).toBe("/portal/forms/completed");
  });

  it("the Completed tab lists submitted forms with their submitted date", async () => {
    render(<ManagerFormsPage tab="completed" />);
    expect(await screen.findByText("Move-in checklist")).toBeTruthy();
    expect(screen.getByText("Submitted Oct 2")).toBeTruthy();
    expect(screen.queryByText("Resident intake")).toBeNull();
  });

  it("a row is tile · form name · resident, property and room · what it blocks · due date, with no pill", async () => {
    render(<ManagerFormsPage />);
    const row = (await screen.findByText("Pet agreement")).closest('[data-attr="forms-row"]') as HTMLElement;
    expect(within(row).getByText(/Maya Chen · Alder Row · Room 1/)).toBeTruthy();
    expect(within(row).getByText("Blocks Lease signing")).toBeTruthy();
    expect(within(row).getByText(/Due Oct 19/)).toBeTruthy();
    expect(within(row).queryByText("Pending")).toBeNull();
  });

  it("reads what an old intake form blocks from its kind when no value was stored", async () => {
    client.loadMoveInForms.mockResolvedValue({ forms: [copy({ id: "i", formName: "Intake", kind: "intake", blocks: undefined as never })], unread: 0 });
    render(<ManagerFormsPage />);
    const row = (await screen.findByText("Intake")).closest('[data-attr="forms-row"]') as HTMLElement;
    expect(within(row).getByText("Blocks Move-in details")).toBeTruthy();
  });

  it("the ⋯ of a pending row offers Edit first, then Remind, with Cancel request last; a completed row View and Download PDF", async () => {
    const user = await getUser();
    render(<ManagerFormsPage />);
    await screen.findByText("Pet agreement");
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Actions for Pet agreement" }));
    });
    const labels = (await screen.findAllByRole("menuitem", {}, { timeout: 3000 })).map((el) => el.textContent?.trim());
    expect(labels).toEqual(["Edit", "Remind", "Cancel request"]);
    cleanup();
    render(<ManagerFormsPage tab="completed" />);
    await screen.findByText("Move-in checklist");
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Actions for Move-in checklist" }));
    });
    expect((await screen.findAllByRole("menuitem")).map((el) => el.textContent?.trim())).toEqual(["View", "Download PDF"]);
  });

  it("Edit opens the edit popup for that form", async () => {
    client.getMoveInForm.mockResolvedValue({ form: { ...copy({ id: "b", formName: "Pet agreement" }), answers: [], snapshot: { questions: [], pdf: null, kind: "other", blocks: "lease_signing" } } });
    const user = await getUser();
    render(<ManagerFormsPage />);
    await screen.findByText("Pet agreement");
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Actions for Pet agreement" }));
    });
    await act(async () => {
      await user.click(await screen.findByRole("menuitem", { name: "Edit" }, { timeout: 3000 }));
    });
    await waitFor(() => expect(client.getMoveInForm).toHaveBeenCalledWith("b"));
    expect((await screen.findAllByText("Edit Pet agreement")).length).toBeGreaterThan(0);
  });

  it("a search narrows the rows, and an empty bucket says so", async () => {
    render(<ManagerFormsPage />);
    fireEvent.change(await screen.findByPlaceholderText("Search forms"), { target: { value: "maya" } });
    expect(screen.getByText("Pet agreement")).toBeTruthy();
    expect(screen.queryByText("Resident intake")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search forms"), { target: { value: "zzz" } });
    expect(await screen.findByText(/No forms match/)).toBeTruthy();
    cleanup();
    client.loadMoveInForms.mockResolvedValue({ forms: [], unread: 0 });
    render(<ManagerFormsPage tab="completed" />);
    expect(await screen.findByText("No completed forms")).toBeTruthy();
  });
});

describe("resident record › Forms", () => {
  it("lists only that resident's forms, with no resident in the place line", async () => {
    render(<FormsList userId="u1" basePath="/portal" bucket="pending" applicationId="app-1" bucketHref={(b) => `/portal/residents/current/app-1/forms${b === "pending" ? "" : `/${b}`}`} />);
    expect(await screen.findByText("Resident intake")).toBeTruthy();
    expect(screen.queryByText("Pet agreement")).toBeNull();
    expect(client.loadMoveInForms).toHaveBeenCalledWith("u1", "manager", { applicationId: "app-1" }, false);
    expect(screen.queryByText(/Atlas Bailly ·/)).toBeNull();
    expect(document.querySelector('[data-attr="forms-tab-completed"]')?.getAttribute("href")).toBe("/portal/residents/current/app-1/forms/completed");
  });
});
