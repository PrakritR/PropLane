// @vitest-environment jsdom
//
// EVIDENCE HARNESS for "Add payment pays a vendor, a teammate, or another payee"
// (studio plan claude-2/services-vendors-1004, area 2).
//
// Renders the real Add payment modal and, with EVIDENCE_DIR set, writes the
// Pay to step, the saved-payee picker and the New payee detail form out as HTML
// so a reviewer can see the screen rather than a selector list.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearAllWorkspaceDrafts } from "@/components/portal/add-workspace/draft";
import { ManagerAddOutgoingPaymentModal } from "@/components/portal/pro-add-outgoing-payment-modal";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const captured: { name: string; html: string }[] = [];
function capture(name: string) {
  if (!EVIDENCE_DIR) return;
  captured.push({ name, html: document.body.innerHTML });
}
afterAll(() => {
  if (!EVIDENCE_DIR || captured.length === 0) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, html } of captured) writeFileSync(join(EVIDENCE_DIR, `${name}.fragment.html`), html, "utf8");
});

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

const CHASE = {
  id: "p1", kind: "other", payeeType: "mortgage", name: "Chase Home Lending", accountReference: "4821",
  email: null, phone: null, address: null, payMethod: "online", notes: null,
  vendorDirectoryId: null, teammateUserId: null, archivedAt: null,
};

beforeEach(() => {
  clearAllWorkspaceDrafts();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.startsWith("/api/manager/payees")
      ? { payees: [CHASE], teammates: [{ userId: "t1", name: "Jordan Lee", email: null, roleLabel: "Admin" }] }
      : url.includes("choices=1")
        ? { services: [] }
        : { invoices: [] };
    return { ok: true, status: 200, json: async () => body } as Response;
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Add payment — who gets paid", () => {
  it("opens on Pay to with a vendor, a teammate and someone else", async () => {
    render(<ManagerAddOutgoingPaymentModal open onClose={vi.fn()} managerUserId="mgr-1" onSubmitted={vi.fn()} />);
    expect(screen.getByRole("button", { name: "A vendor" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "A teammate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Someone else" })).toBeTruthy();
    capture("add-payment-pay-to");
  });

  it("offers the saved payees, then every detail field a new payee stores", async () => {
    render(<ManagerAddOutgoingPaymentModal open onClose={vi.fn()} managerUserId="mgr-1" onSubmitted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Someone else" }));
    fireEvent.click(screen.getAllByText("Choose payee")[0]!);
    await waitFor(() => expect(screen.getAllByText("Chase Home Lending · Mortgage lender").length).toBeGreaterThan(0));
    capture("add-payment-saved-payees");

    fireEvent.click(screen.getAllByText("New payee")[0]!);
    for (const label of ["Name", "Type", "Account / loan number", "How you pay them", "Phone", "Email", "Address", "Notes"]) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
    }
    capture("add-payment-new-payee");
  });

  it("pays a teammate as a reimbursement", async () => {
    render(<ManagerAddOutgoingPaymentModal open onClose={vi.fn()} managerUserId="mgr-1" onSubmitted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "A teammate" }));
    expect(screen.getAllByText("Teammate").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reimbursement").length).toBeGreaterThan(0);
    capture("add-payment-teammate");
  });
});
