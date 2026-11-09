// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()), isDemoModeActive: () => false }));
vi.mock("@/lib/admin-sms-workspaces", () => ({ ADMIN_SMS_UNASSIGNED_FILTER: "unassigned", useAdminSmsWorkspaces: () => [] }));
vi.mock("@/lib/admin-inbox-source", () => ({ refreshAdminScheduled: vi.fn() }));
vi.mock("@/components/portal/communication-adapters/admin-inbox-adapter", () => ({ createAdminInboxAdapter: () => ({}) }));
vi.mock("@/hooks/use-communication-list-segment", () => ({ useCommunicationListSegment: () => ({ segment: "active", setSegment: vi.fn() }) }));
vi.mock("@/hooks/use-communication-thread-id", () => ({ useCommunicationThreadId: () => ({ activeThreadId: null, setActiveThreadId: vi.fn() }) }));
vi.mock("@/components/portal/portal-communication-shell", () => ({ PortalCommunicationShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/portal/pro-unified-inbox", () => ({ ManagerUnifiedInbox: ({ listPrimary }: { listPrimary: ReactNode }) => <div>{listPrimary}</div> }));
vi.mock("@/components/portal/admin-compose-modal", () => ({ AdminComposeModal: ({ open, onClose, recipients }: { open: boolean; onClose: () => void; recipients: { managers: { name: string }[] } }) => open ? <div><button onClick={onClose}>Close compose</button><output>{recipients.managers.map((person) => person.name).join(", ")}</output></div> : null }));
import { AdminCommunication } from "@/components/portal/admin-communication";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const people = (name: string) => Response.json({ managers: [{ id: name, name, email: `${name}@example.invalid` }], residents: [] });
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}
function open() { fireEvent.click(screen.getByRole("button", { name: "New message" })); }
function close() { fireEvent.click(screen.getByRole("button", { name: "Close compose" })); }

it("publishes a delayed recipient response while compose remains open", async () => {
  const first = deferred();
  const fetchMock = vi.fn(() => first.promise); vi.stubGlobal("fetch", fetchMock);
  render(<AdminCommunication />); open();
  expect(fetchMock).toHaveBeenCalledOnce();
  await act(async () => first.resolve(people("New manager")));
  expect(screen.getByText("New manager")).toBeTruthy();
});

it.each(["HTTP failure", "malformed response"])("retries on reopen after %s", async (failure) => {
  const fetchMock = vi.fn().mockResolvedValueOnce(failure === "HTTP failure" ? new Response("", { status: 503 }) : Response.json({ managers: null, residents: [] })).mockResolvedValueOnce(people("Retry manager"));
  vi.stubGlobal("fetch", fetchMock);
  render(<AdminCommunication />); open();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await act(async () => { await Promise.resolve(); });
  close(); open();
  await waitFor(() => expect(screen.getByText("Retry manager")).toBeTruthy());
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("ignores a cancelled response after reopening", async () => {
  const old = deferred(), current = deferred();
  const fetchMock = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise); vi.stubGlobal("fetch", fetchMock);
  render(<AdminCommunication />); open(); close(); open();
  await act(async () => current.resolve(people("Current manager")));
  expect(screen.getByText("Current manager")).toBeTruthy();
  await act(async () => old.resolve(people("Stale manager")));
  expect(screen.queryByText("Stale manager")).toBeNull();
  expect(screen.getByText("Current manager")).toBeTruthy();
});
