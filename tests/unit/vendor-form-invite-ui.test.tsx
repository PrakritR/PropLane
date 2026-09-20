// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManagerVendorFormModal } from "@/components/portal/pro-vendor-form-modal";

const persistManagerVendorToServer = vi.fn().mockResolvedValue(true);

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
  deliverManagerVendorInvite: (...args: unknown[]) => deliverManagerVendorInvite(...args),
  fetchManagerVendorRemovalDraft: vi.fn(),
}));

vi.mock("@/lib/manager-portfolio-access", () => ({
  buildManagerPropertyFilterOptions: () => [{ id: "house-1", label: "5257 Brooklyn" }],
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),
  useAppUi: () => ({ showToast: vi.fn() }),
}));

const deliverManagerVendorInvite = vi.fn();
function show(onClose = vi.fn()) {
  render(<ManagerVendorFormModal open mode="add" onClose={onClose} showToast={() => {}} />);
  return onClose;
}
function fill(email = "vendor@example.test") {
  fireEvent.change(screen.getByLabelText("Invite by first name"), { target: { value: "Apex Plumbing" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
}
function next() {
  fireEvent.click(screen.getByRole("button", { name: /Continue to / }));
}
function continueToReview() {
  next();
  fill();
  next();
  next();
  next();
  next();
}

describe("three-path vendor invitation", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes("/api/pro/invite-links")) {
          return {
            ok: true,
            json: async () => ({ url: "https://example.test/invite/tok", link: { id: "link-1" } }),
          } as Response;
        }
        return { ok: false, json: async () => ({}) } as Response;
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    persistManagerVendorToServer.mockResolvedValue(true);
  });

  it("preserves current and unknown vendor settings when editing identity fields", async () => {
    const vendor = {
      id: "existing", managerUserId: "owner", name: "Original", trade: "Plumbing", phone: "", email: "", notes: "Private", active: true,
      preferredName: "Sam", preferredChannel: "sms" as const, trades: ["Plumbing", "Electrical"],
      messaging: { instructions: "Keep this", templates: {} }, checkIns: [], propertyIds: ["house"], futureSetting: { enabled: true },
    };
    render(<ManagerVendorFormModal open mode="edit" vendor={vendor} onClose={vi.fn()} showToast={() => {}} />);
    fireEvent.change(screen.getByLabelText("Vendor name"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to Properties" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Who can handle" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Typical price" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Save vendor" }));
    await waitFor(() => expect(persistManagerVendorToServer).toHaveBeenCalledOnce());
    expect(persistManagerVendorToServer.mock.calls[0][0]).toMatchObject({ ...vendor, name: "Updated" });
  });

  it("picks houses from a dropdown and can share on PropLane", () => {
    show();
    next();
    fill();
    next();
    expect(screen.getByLabelText("Properties")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Every property" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Properties"));
    expect(screen.getByRole("option", { name: "Every property" })).toBeInTheDocument();
    next();
    next();
    next();
    expect(screen.getByLabelText("Share on PropLane")).toBeInTheDocument();
  });

  it("opens on Invite by, then Contact", () => {
    show();
    expect(screen.getByLabelText("Invite by")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue to Contact/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Invite by first name")).not.toBeInTheDocument();
    next();
    expect(screen.getByLabelText("Invite by first name")).toBeInTheDocument();
  });

  it("rejects missing name and malformed email before any write", async () => {
    show();
    next();
    fireEvent.click(screen.getByRole("button", { name: /Continue to Properties/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Vendor name is required");
    fill("invalid");
    fireEvent.click(screen.getByRole("button", { name: /Continue to Properties/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("valid email");
    expect(persistManagerVendorToServer).not.toHaveBeenCalled();
  });

  it("mints a link on Invite vendor and stays on the form so it can be copied", async () => {
    const closed = show();
    continueToReview();
    fireEvent.click(screen.getByRole("button", { name: "Invite vendor" }));
    await waitFor(() => expect(persistManagerVendorToServer).toHaveBeenCalledOnce());
    expect(await screen.findByDisplayValue("https://example.test/invite/tok")).toBeInTheDocument();
    expect(closed).not.toHaveBeenCalled();
    expect(deliverManagerVendorInvite).not.toHaveBeenCalled();
  });

  it("keeps the form after persistence failure and does not mint", async () => {
    persistManagerVendorToServer.mockResolvedValue(false);
    const closed = show();
    continueToReview();
    fireEvent.click(screen.getByRole("button", { name: "Invite vendor" }));
    await screen.findByRole("alert");
    expect(closed).not.toHaveBeenCalled();
  });
});
