// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const rows = [
  { id: "read", folder: "sent", from: "Me", email: "read@example.test", subject: "Read subject", body: "Read body", preview: "Read body", unread: false, time: "Sep 10, 2026" },
  { id: "unread", folder: "inbox", from: "Unread person", email: "unread@example.test", subject: "Unread subject", body: "Unread body", preview: "Unread body", unread: true, time: "Sep 11, 2026" },
  { id: "archived", folder: "trash", from: "Archived person", email: "archived@example.test", subject: "Archived subject", body: "Archived body", preview: "Archived body", unread: false, time: "Sep 09, 2026" },
];
vi.mock("next/navigation", () => ({ usePathname: () => "/resident/communication/active", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/use-portal-session", () => ({ usePortalSession: () => ({ ready: true, userId: "status-viewer", user: { id: "status-viewer" } }) }));
vi.mock("@/hooks/use-resident-manager-contacts", () => ({ useResidentManagerContacts: () => [] }));
vi.mock("@/lib/portal-inbox-storage", async (original) => ({
  ...await original<typeof import("@/lib/portal-inbox-storage")>(),
  loadPersistedInbox: () => rows,
  syncPersistedInboxFromServer: async () => rows,
  syncPersistedInboxFromServerWithStatus: async () => ({ rows, ok: true }),
  inboxThreadMessages: () => [],
}));
vi.mock("@/components/portal/portal-communication-shell", () => ({ PortalCommunicationShell: ({ children, titleAside }: { children: ReactNode; titleAside: ReactNode }) => <>{titleAside}{children}</> }));
vi.mock("@/components/portal/portal-filter-sort-sheet", () => ({ PortalFilterSortSheet: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/portal/filter-field-lists", () => ({
  FilterCollapsibleSection: ({ children }: { children: ReactNode }) => <>{children}</>,
  FilterSingleSelectList: ({ options, value, onChange }: { options: { value: string; label: string }[]; value: string; onChange: (value: string) => void }) => <select aria-label="Status" value={value} onChange={(e) => onChange(e.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>,
}));
vi.mock("@/components/portal/resident-inbox-panel", () => ({ ResidentInboxPanel: () => null }));
vi.mock("@/components/portal/vendor-inbox-panel", () => ({ VendorInboxPanel: () => null }));
vi.mock("@/components/portal/resident-manager-number-card", () => ({ ResidentManagerNumberCard: () => null }));
vi.mock("@/components/portal/vendor-work-number-card", () => ({ VendorWorkNumberCard: () => null }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useConfirm: () => vi.fn(), useAppUi: () => ({ showToast: vi.fn() }) }));
import { ResidentCommunication } from "@/components/portal/resident-communication";
import { VendorCommunication } from "@/components/portal/vendor-communication";
afterEach(cleanup);
describe.each([ResidentCommunication, VendorCommunication])("status filtering", (Component) => {
  it("filters read and unread, searches archives, and resets to all live conversations", async () => {
    render(<Component />);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "read" } });
    await waitFor(() => expect(screen.getByText("Read subject")).toBeTruthy());
    expect(screen.queryByText("Unread subject")).toBeNull();
    expect(screen.queryByText("Archived subject")).toBeNull();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "unread" } });
    await waitFor(() => expect(screen.getByText("Unread subject")).toBeTruthy());
    expect(screen.queryByText("Read subject")).toBeNull();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "archived" } });
    fireEvent.change(screen.getByLabelText("Search messages"), { target: { value: "Archived" } });
    await waitFor(() => expect(screen.getByText("Archived subject")).toBeTruthy());
    expect(screen.queryByText("Unread subject")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search messages"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "active" } });
    await waitFor(() => expect(screen.getByText("Unread subject")).toBeTruthy());
    expect(screen.getByText("Read subject")).toBeTruthy();
    expect(screen.queryByText("Archived subject")).toBeNull();
  });
});
