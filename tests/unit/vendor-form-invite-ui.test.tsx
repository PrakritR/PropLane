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
  deliverManagerVendorInvite: vi.fn(),
  fetchManagerVendorInviteDraft: (...args: unknown[]) => fetchManagerVendorInviteDraft(...args),
  fetchManagerVendorRemovalDraft: vi.fn(),
}));

describe("ManagerVendorFormModal invite flow", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("step one shows essentials only and advances on Continue", async () => {
    render(
      <ManagerVendorFormModal
        open
        mode="add"
        onClose={() => {}}
        showToast={() => {}}
      />,
    );

    expect(screen.getByRole("heading", { name: "Invite vendor" })).toBeInTheDocument();
    expect(screen.getByText("Invite by email")).toBeInTheDocument();
    expect(screen.queryByText("Priority for this trade")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("e.g. Apex Plumbing"), {
      target: { value: "Apex Plumbing" },
    });
    fireEvent.change(screen.getByPlaceholderText("vendor@company.com"), {
      target: { value: "vendor@example.com" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Send invite" })).toBeInTheDocument();
    });
    expect(screen.getByText("Apex Plumbing")).toBeInTheDocument();
    expect(screen.getByText(/vendor@example.com/)).toBeInTheDocument();
    expect(screen.getByText("Priority for this trade")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send invite" })).toBeInTheDocument();
  });

  it("blocks Continue without a vendor name", () => {
    render(
      <ManagerVendorFormModal
        open
        mode="add"
        onClose={() => {}}
        showToast={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Vendor name is required.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Invite vendor" })).toBeInTheDocument();
  });

  it("blocks Continue on malformed email", () => {
    render(
      <ManagerVendorFormModal
        open
        mode="add"
        onClose={() => {}}
        showToast={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("e.g. Apex Plumbing"), {
      target: { value: "Apex Plumbing" },
    });
    fireEvent.change(screen.getByPlaceholderText("vendor@company.com"), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText(/Enter a valid email address/)).toBeInTheDocument();
  });

  it("adds without invite when email is blank on step two", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(
      <ManagerVendorFormModal
        open
        mode="add"
        onClose={onClose}
        onSaved={onSaved}
        showToast={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("e.g. Apex Plumbing"), {
      target: { value: "No Email Vendor" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add vendor" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Add vendor" }));

    await waitFor(() => {
      expect(persistManagerVendorToServer).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
      expect(onSaved).toHaveBeenCalled();
    });
    expect(fetchManagerVendorInviteDraft).not.toHaveBeenCalled();
  });

  it("opens invite preview when email is present on step two", async () => {
    fetchManagerVendorInviteDraft.mockResolvedValue({
      ok: true,
      preview: {
        vendorId: "vend-new-1",
        email: "vendor@example.com",
        subject: "Join PropLane",
        body: "Welcome aboard",
      },
    });

    render(
      <ManagerVendorFormModal
        open
        mode="add"
        onClose={() => {}}
        showToast={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("e.g. Apex Plumbing"), {
      target: { value: "Apex Plumbing" },
    });
    fireEvent.change(screen.getByPlaceholderText("vendor@company.com"), {
      target: { value: "vendor@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Send invite" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() => {
      expect(fetchManagerVendorInviteDraft).toHaveBeenCalled();
      expect(screen.getByRole("heading", { name: /notification preview/i })).toBeInTheDocument();
    });
  });

  it("Back returns to essentials without losing entered values", async () => {
    render(
      <ManagerVendorFormModal
        open
        mode="add"
        onClose={() => {}}
        showToast={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("e.g. Apex Plumbing"), {
      target: { value: "Apex Plumbing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.getByRole("heading", { name: "Invite vendor" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Apex Plumbing")).toBeInTheDocument();
  });
});
