// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManagerVendorFormModal } from "@/components/portal/pro-vendor-form-modal";

const persistManagerVendorToServer = vi.fn().mockResolvedValue(true);
const fetchManagerVendorInviteDraft = vi.fn();

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
  fetchManagerVendorInviteDraft: (...args: unknown[]) => fetchManagerVendorInviteDraft(...args),
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

describe("single-form vendor invitation", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); persistManagerVendorToServer.mockResolvedValue(true); });
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
  it("shows identity, phone and invitation message together without Continue", () => {
    show();
    expect(screen.getByLabelText("Vendor name")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Invitation message")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create invite link" })).toBeInTheDocument();
  });
  it("rejects missing name and malformed email before any write", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Add vendor" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Vendor name is required");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add vendor" })).not.toBeDisabled());
    fill("invalid"); fireEvent.click(screen.getByRole("button", { name: "Add vendor" }));
    expect(screen.getByRole("alert")).toHaveTextContent("valid email");
    expect(persistManagerVendorToServer).not.toHaveBeenCalled();
  });
  it("adds without sending when email is blank", async () => {
    const closed = show(); fill(""); fireEvent.click(screen.getByRole("button", { name: "Add vendor" }));
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(fetchManagerVendorInviteDraft).not.toHaveBeenCalled();
  });
  it("sends the visible message with the server link, excluding private notes", async () => {
    fetchManagerVendorInviteDraft.mockResolvedValue({ ok: true, preview: { vendorId: "vend-new-1", email: "vendor@example.test", name: "Apex", phone: "", subject: "Join PropLane", body: "Default", linkUrl: "https://example.test/invite/server-token" } });
    deliverManagerVendorInvite.mockResolvedValue({ ok: true, message: "Sent" });
    const closed = show(); fill();
    fireEvent.change(screen.getByLabelText("Invitation message"), { target: { value: "Please join our team." } });
    fireEvent.change(screen.getByLabelText("Private notes"), { target: { value: "Internal billing note" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(deliverManagerVendorInvite).toHaveBeenCalledWith(expect.anything(), false, { viaEmail: true, viaInbox: true, viaSms: false }, { subject: "Join PropLane", body: "Please join our team.\n\nJoin PropLane: https://example.test/invite/server-token" });
    expect(screen.queryByRole("heading", { name: /notification preview/i })).not.toBeInTheDocument();
  });
  it("keeps the form and draft after persistence failure and does not send", async () => {
    persistManagerVendorToServer.mockResolvedValue(false);
    const closed = show(); fill();
    fireEvent.change(screen.getByLabelText("Invitation message"), { target: { value: "Keep my message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Invitation message")).toHaveValue("Keep my message");
    expect(closed).not.toHaveBeenCalled(); expect(fetchManagerVendorInviteDraft).not.toHaveBeenCalled();
  });
  it("retains the same vendor id on a send failure and retry", async () => {
    fetchManagerVendorInviteDraft.mockResolvedValue({ ok: true, preview: { vendorId: "vend-new-1", email: "vendor@example.test", name: "Apex", subject: "Join", body: "Default", linkUrl: "https://example.test/invite" } });
    deliverManagerVendorInvite.mockResolvedValueOnce({ ok: false, message: "Delivery unavailable." }).mockResolvedValueOnce({ ok: true, message: "Sent" });
    const closed = show(); fill(); fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await screen.findByRole("alert"); expect(closed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(fetchManagerVendorInviteDraft).toHaveBeenCalledTimes(1);
    expect(new Set(persistManagerVendorToServer.mock.calls.map(([row]) => row.id))).toEqual(new Set(["vend-new-1"]));
  });
  it("guards close and duplicate submissions while sending", async () => {
    let finish!: (result: unknown) => void;
    deliverManagerVendorInvite.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const closed = show(); fill();
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(deliverManagerVendorInvite).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create invite link" })).toBeDisabled();
    fireEvent.submit(document.getElementById("vendor-invite-form")!);
    expect(deliverManagerVendorInvite).toHaveBeenCalledOnce();
    finish({ ok: true, message: "Sent" });
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
  });

});
