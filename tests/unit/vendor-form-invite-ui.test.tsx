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
  setManagerVendorPriority: vi.fn(),
  upsertManagerVendor: vi.fn(),
}));

vi.mock("@/lib/manager-vendor-invite-client", () => ({
  deliverManagerDirectoryMessage: vi.fn(),
  deliverManagerVendorInvite: (...args: unknown[]) => deliverManagerVendorInvite(...args),
  fetchManagerVendorRemovalDraft: vi.fn(),
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
  fireEvent.change(screen.getByLabelText("Vendor name"), { target: { value: "Apex Plumbing" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
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
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await waitFor(() => expect(persistManagerVendorToServer).toHaveBeenCalledOnce());
    expect(persistManagerVendorToServer.mock.calls[0][0]).toMatchObject({ ...vendor, name: "Updated" });
  });

  it("shows three invite methods and Continue", () => {
    show();
    expect(screen.getByRole("tab", { name: "Invite via link" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Invite via message" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Invite via PropLane code" })).toBeInTheDocument();
    expect(screen.getByLabelText("Vendor name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Invitation message")).not.toBeInTheDocument();
  });

  it("rejects missing name and malformed email before any write", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Vendor name is required");
    fill("invalid");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("valid email");
    expect(persistManagerVendorToServer).not.toHaveBeenCalled();
  });

  it("mints a link on Continue and stays on the form so it can be copied", async () => {
    const closed = show();
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(persistManagerVendorToServer).toHaveBeenCalledOnce());
    expect(await screen.findByDisplayValue("https://example.test/invite/tok")).toBeInTheDocument();
    expect(closed).not.toHaveBeenCalled();
    expect(deliverManagerVendorInvite).not.toHaveBeenCalled();
  });

  it("keeps the form after persistence failure and does not mint", async () => {
    persistManagerVendorToServer.mockResolvedValue(false);
    const closed = show();
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Vendor name")).toHaveValue("Apex Plumbing");
    expect(closed).not.toHaveBeenCalled();
  });
});
