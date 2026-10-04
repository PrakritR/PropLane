// @vitest-environment jsdom
//
// "Add payment": Pay to · Payment · Review. A vendor with a login is a one-step invoice path; a
// teammate or someone else walks all three steps.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearAllWorkspaceDrafts } from "@/components/portal/add-workspace/draft";
import { ManagerAddOutgoingPaymentModal } from "@/components/portal/pro-add-outgoing-payment-modal";

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/outgoing/to-pay",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: vi.fn() }),
  useOptionalAppUi: () => null,
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => vi.fn() }));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "mgr-1", ready: true }) }));
vi.mock("@/hooks/use-portal-session", () => ({ usePortalSession: () => ({ userId: "mgr-1", email: null, ready: true }) }));
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo-property-pipeline")>()),
  syncPropertyPipelineFromServer: async () => [],
}));
vi.mock("@/lib/manager-vendors-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-vendors-storage")>()),
  readOwnActiveManagerVendorRows: () => [
    { id: "r1", name: "Rapid Pipes", trade: "Plumbing", vendorUserId: "vu-1", active: true },
  ],
  syncManagerVendorsFromServer: async () => [],
}));
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const CHASE = { id: "p1", kind: "other", payeeType: "mortgage", name: "Chase Home Lending", accountReference: "4821", email: null, phone: null, address: null, payMethod: "online", notes: null, vendorDirectoryId: null, teammateUserId: null, archivedAt: null };

beforeEach(() => {
  clearAllWorkspaceDrafts();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.startsWith("/api/manager/payees")
      ? { payees: [CHASE], teammates: [{ userId: "t1", name: "Jordan Lee", email: null, roleLabel: "Admin" }] }
      : url.includes("choices=1")
        ? { services: [] }
        : { invoices: [{ id: "inv1", vendorUserId: "vu-1", vendorName: "Rapid Pipes", invoiceNumber: "INV-1042", serviceTitle: "Kitchen faucet drip", totalCents: 16400, status: "approved" }] };
    return { ok: true, status: 200, json: async () => body } as Response;
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderModal = (props: Partial<React.ComponentProps<typeof ManagerAddOutgoingPaymentModal>> = {}) =>
  render(<ManagerAddOutgoingPaymentModal open onClose={vi.fn()} managerUserId="mgr-1" onSubmitted={vi.fn()} {...props} />);

describe("Add payment modal", () => {
  it("opens on Pay to with the three payee kinds and the three steps", async () => {
    renderModal();
    expect(screen.getAllByText("Add payment").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "A vendor" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "A teammate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Someone else" })).toBeTruthy();
    expect(screen.getAllByText("Pay to").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Payment").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Review").length).toBeGreaterThan(0);
  });

  it("Someone else offers saved payees plus New payee, and New payee shows every detail field", async () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Someone else" }));
    expect(screen.getAllByText("Payee").length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByText("Choose payee")[0]!);
    await waitFor(() => expect(screen.getAllByText("Chase Home Lending · Mortgage lender").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("New payee")[0]!);
    for (const label of ["Name", "Type", "Account / loan number", "How you pay them", "Phone", "Email", "Address", "Notes"]) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
    }
  });

  it("a vendor with a login is one step: no Payment or Review", async () => {
    renderModal({ initialVendorId: "r1" });
    await waitFor(() => expect(screen.getAllByText("For").length).toBeGreaterThan(0));
    expect(screen.queryByText("Review")).toBeNull();
    expect(screen.getAllByText("Continue").length).toBeGreaterThan(0);
  });

  it("a teammate asks who and why", async () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "A teammate" }));
    expect(screen.getAllByText("Teammate").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reimbursement").length).toBeGreaterThan(0);
  });
});
