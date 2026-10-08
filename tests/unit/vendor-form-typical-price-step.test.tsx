// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearAllWorkspaceDrafts } from "@/components/portal/add-workspace/draft";
import { ManagerVendorFormModal } from "@/components/portal/pro-vendor-form-modal";
import { ALL_PROPERTIES_RATE_ID } from "@/lib/manager-vendor-typical-rates";

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
function pick(name: string) {
  const option = screen.getByRole("option", { name });
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 0, clientY: 0 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 0, clientY: 0 });
}
function toProperties() {
  render(<ManagerVendorFormModal open mode="add" onClose={vi.fn()} showToast={() => {}} />);
  next();
  fireEvent.change(screen.getByLabelText("Invite by first name"), { target: { value: "Apex Plumbing" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "vendor@example.test" } });
  next();
}

describe("Add vendor > Typical price step", () => {
  afterEach(() => {
    cleanup();
    clearAllWorkspaceDrafts();
    vi.clearAllMocks();
    persistManagerVendorToServer.mockResolvedValue(true);
  });

  it("shows editable prices for Every property even when no house is loaded in the browser", async () => {
    portfolio.options = [];
    toProperties();
    next();
    next();
    expect(screen.queryByText("Pick a property and a trade first.")).not.toBeInTheDocument();
    const hourly = screen.getAllByLabelText("Hourly");
    expect(hourly).toHaveLength(1);
    fireEvent.change(hourly[0]!, { target: { value: "95" } });
    fireEvent.change(screen.getByLabelText("Typical service"), { target: { value: "185.50" } });
    next();
    fireEvent.click(screen.getByRole("button", { name: "Invite vendor" }));
    await waitFor(() => expect(persistManagerVendorToServer).toHaveBeenCalledOnce());
    const saved = persistManagerVendorToServer.mock.calls[0]![0] as {
      propertyIds?: string[];
      typicalRates: { propertyId: string; hourlyCents: number; serviceCents: number }[];
    };
    expect(saved.propertyIds).toBeUndefined();
    expect(saved.typicalRates).toEqual([
      expect.objectContaining({ propertyId: ALL_PROPERTIES_RATE_ID, hourlyCents: 9500, serviceCents: 18550 }),
    ]);
  });

  it("shows one price row per trade for Every property when houses are loaded", () => {
    portfolio.options = [
      { id: "house-1", label: "5257 Brooklyn" },
      { id: "house-2", label: "4709A 8th Ave" },
    ];
    toProperties();
    next();
    next();
    expect(screen.getAllByLabelText("Hourly")).toHaveLength(1);
    expect(screen.getByRole("group", { name: "Every property" })).toBeInTheDocument();
  });

  it("keeps a price row per selected house for specific properties", () => {
    portfolio.options = [
      { id: "house-1", label: "5257 Brooklyn" },
      { id: "house-2", label: "4709A 8th Ave" },
    ];
    toProperties();
    fireEvent.click(screen.getByLabelText("Properties"));
    pick("5257 Brooklyn");
    pick("4709A 8th Ave");
    next();
    next();
    expect(screen.getByText("5257 Brooklyn")).toBeInTheDocument();
    expect(screen.getByText("4709A 8th Ave")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Hourly")).toHaveLength(2);
    fireEvent.change(screen.getAllByLabelText("Hourly")[0]!, { target: { value: "80" } });
    expect((screen.getAllByLabelText("Hourly")[0] as HTMLInputElement).value).toBe("80");
  });
});
