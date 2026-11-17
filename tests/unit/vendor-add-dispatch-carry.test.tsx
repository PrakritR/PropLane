// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearAllWorkspaceDrafts } from "@/components/portal/add-workspace/draft";
import { ManagerVendorFormModal } from "@/components/portal/pro-vendor-form-modal";


const persistManagerVendorToServer = vi.fn().mockResolvedValue(true);
const portfolio = vi.hoisted(() => ({ options: [] as { id: string; label: string }[] }));

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-test-1", ready: true }),
}));
vi.mock("@/lib/manager-vendors-storage", () => ({
  deleteManagerVendorRow: vi.fn(),
  makeVendorId: () => "vend-new-1",
  persistManagerVendorToServer: (...args: unknown[]) => persistManagerVendorToServer(...args),
  readOwnManagerVendorRows: () => [],
  setManagerVendorPriority: vi.fn(),
  upsertManagerVendor: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  readPendingManagerPropertiesForUser: () => [],
  readScopedExtraListings: () => [],
}));
vi.mock("@/lib/manager-vendor-invite-client", () => ({
  deliverManagerDirectoryMessage: vi.fn(),
  deliverManagerVendorInvite: vi.fn(),
  fetchManagerVendorRemovalDraft: vi.fn(),
}));
vi.mock("@/lib/manager-portfolio-access", () => ({
  buildManagerPropertyFilterOptions: () => portfolio.options,
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: vi.fn() }),
}));

function next() {
  fireEvent.click(screen.getByRole("button", { name: /Next: / }));
}
function toTrades() {
  next();
  fireEvent.change(screen.getByLabelText("Invite by first name"), { target: { value: "Apex" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "v@example.test" } });
  next();
  next();
}

describe("Add vendor > trades carry into Dispatch", () => {
  afterEach(() => {
    cleanup();
    clearAllWorkspaceDrafts();
    vi.clearAllMocks();
  });

  it("shows General maintenance as Handyman on Dispatch without touching it", () => {
    render(<ManagerVendorFormModal open mode="add" onClose={vi.fn()} showToast={() => {}} />);
    toTrades();
    next();
    const dispatch = document.querySelector('[data-attr="vendor-dispatch-trades"]');
    expect(dispatch?.textContent ?? document.body.textContent).toContain("Handyman");
  });

  it("follows a newly ticked trade until Dispatch is set by hand", () => {
    render(<ManagerVendorFormModal open mode="add" onClose={vi.fn()} showToast={() => {}} />);
    toTrades();
    fireEvent.click(screen.getByLabelText("Plumbing"));
    next();
    expect(document.body.textContent).toContain("Plumber");
    expect(document.body.textContent).toContain("Handyman");
  });

  it("leaves an edited vendor's Dispatch roles alone", () => {
    const vendor = {
      id: "existing", managerUserId: "owner", name: "Original", trade: "Plumbing", phone: "", email: "", notes: "", active: true,
      trades: ["Plumbing"], dispatchTrades: ["hvac"], messaging: { instructions: "", templates: {} }, checkIns: [],
    };
    render(<ManagerVendorFormModal open mode="edit" vendor={vendor as never} onClose={vi.fn()} showToast={() => {}} />);
    next();
    next();
    fireEvent.click(screen.getByLabelText("Electrical"));
    next();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Heating and cooling");
    expect(text).not.toContain("Electrician");
  });
});
