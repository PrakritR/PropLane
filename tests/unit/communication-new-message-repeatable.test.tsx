// @vitest-environment jsdom
/**
 * "New message" is repeatable. The sidebar button and the command palette push
 * `…/communication/active?compose=1`; the page consumes the flag once it has
 * opened the compose, so closing it and clicking New message again is a real
 * URL change that opens it again (it used to do nothing the second time).
 */
import { forwardRef, useImperativeHandle, useState, useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

// A router-shaped store: pushState / replaceState notify useSearchParams, the
// way the App Router syncs window.history into it.
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
function clickNewMessage(path: string) {
  window.history.pushState(null, "", `${path}?compose=1`);
  notify();
}
vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => {
    const search = useSyncExternalStore(
      (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      () => window.location.search,
      () => "",
    );
    return new URLSearchParams(search);
  },
}));

vi.mock("@/components/providers/app-ui-provider", () => ({ useConfirm: () => vi.fn(), useAppUi: () => ({ showToast: vi.fn() }) }));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "manager-1", ready: true }) }));
vi.mock("@/lib/portal-base-path-client", () => ({ usePaidPortalBasePath: () => "/portal" }));
vi.mock("@/lib/manager-sms-conversations-client", () => ({ loadManagerSmsConversationsClient: async () => [] }));
vi.mock("@/lib/sms/manager-messaging-number-client", () => ({ loadManagerMessagingNumberStatusClient: async () => ({}) }));
vi.mock("@/components/portal/portal-communication-shell", () => ({
  PortalCommunicationShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/portal/pro-unified-inbox", () => ({ ManagerUnifiedInbox: () => null }));
vi.mock("@/components/portal/portal-filter-sort-sheet", () => ({ PortalFilterSortSheet: () => null }));
vi.mock("@/components/portal/pro-communication-compose-modal", () => ({
  ManagerCommunicationComposeModal: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? (
      <div role="dialog" aria-label="New message">
        <button type="button" onClick={onClose}>
          Close compose
        </button>
      </div>
    ) : null,
}));
vi.mock("@/components/portal/vendor-inbox-panel", () => ({
  VendorInboxPanel: forwardRef<{ openCompose: () => void }>(function VendorInboxPanelMock(_props, ref) {
    const [open, setOpen] = useState(false);
    useImperativeHandle(ref, () => ({ openCompose: () => setOpen(true) }), []);
    return open ? (
      <div role="dialog" aria-label="New message">
        <button type="button" onClick={() => setOpen(false)}>
          Close compose
        </button>
      </div>
    ) : null;
  }),
}));
vi.mock("@/components/portal/vendor-work-number-card", () => ({ VendorWorkNumberCard: () => null }));

import { ManagerCommunication } from "@/components/portal/pro-communication";
import { VendorCommunication } from "@/components/portal/vendor-communication";
import { consumeComposeQueryParam } from "@/lib/portals/compose-query";

const realReplaceState = window.history.replaceState.bind(window.history);

beforeEach(() => {
  // The App Router makes replaceState visible to useSearchParams; so does this.
  window.history.replaceState = (...args: Parameters<History["replaceState"]>) => {
    realReplaceState(...args);
    notify();
  };
});
afterEach(() => {
  cleanup();
  window.history.replaceState = realReplaceState;
});

describe.each([
  ["manager", ManagerCommunication, "/portal/communication/active"],
  ["vendor", VendorCommunication, "/vendor/communication/active"],
] as const)("%s New message is repeatable", (_name, Component, path) => {
  it("opens, closes, and opens again on the next New message click", async () => {
    window.history.pushState(null, "", path);
    render(<Component />);
    expect(screen.queryByRole("dialog", { name: "New message" })).toBeNull();

    for (const round of [1, 2, 3]) {
      await act(async () => clickNewMessage(path));
      await waitFor(() => expect(screen.getByRole("dialog", { name: "New message" })).toBeTruthy(), { timeout: 3000 });
      // The flag was consumed once the compose opened.
      await waitFor(() => expect(window.location.search).toBe(""));
      await act(async () => screen.getByRole("button", { name: "Close compose" }).click());
      expect(screen.queryByRole("dialog", { name: "New message" }), `round ${round} closed`).toBeNull();
    }
  });
});

describe("consumeComposeQueryParam", () => {
  it("drops only compose and keeps the other params and history state", () => {
    window.history.pushState({ keep: 1 }, "", "/resident/communication/active?propertyId=p1&compose=1&x=2#h");
    consumeComposeQueryParam();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/resident/communication/active?propertyId=p1&x=2#h",
    );
    expect(window.history.state).toEqual({ keep: 1 });
  });
});
