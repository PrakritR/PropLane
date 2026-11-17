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

describe("Add vendor > price adornment and Review line", () => {
  afterEach(() => {
    cleanup();
    clearAllWorkspaceDrafts();
    vi.clearAllMocks();
  });

  it("prefixes the price inputs with $ and summarizes them on Review", () => {
    render(<ManagerVendorFormModal open mode="add" onClose={vi.fn()} showToast={() => {}} />);
    next();
    fireEvent.change(screen.getByLabelText("Invite by first name"), { target: { value: "Apex" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "v@example.test" } });
    next();
    next();
    next();
    next();
    const hourly = screen.getByLabelText("Hourly");
    expect(hourly.parentElement?.textContent).toContain("$");
    expect(screen.getByLabelText("Typical service").parentElement?.textContent).toContain("$");
    fireEvent.change(hourly, { target: { value: "75" } });
    fireEvent.change(screen.getByLabelText("Typical service"), { target: { value: "150" } });
    next();
    expect(document.body.textContent).toContain("Hourly $75 · Typical service $150");
  });

  it("omits the line when no price is set", () => {
    render(<ManagerVendorFormModal open mode="add" onClose={vi.fn()} showToast={() => {}} />);
    next();
    fireEvent.change(screen.getByLabelText("Invite by first name"), { target: { value: "Apex" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "v@example.test" } });
    next();
    next();
    next();
    next();
    next();
    expect(document.body.textContent).not.toContain("Typical price:");
  });
});
