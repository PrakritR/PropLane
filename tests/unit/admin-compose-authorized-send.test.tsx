// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminComposeModal } from "@/components/portal/admin-compose-modal";

const mocks = vi.hoisted(() => ({ append: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/demo-admin-partner-inbox", () => ({ appendInboxMessage: mocks.append }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: mocks.toast }) }));
vi.mock("@/components/portal/portal-dialog", () => ({ PortalDialog: ({ open, children, primaryAction, onClose }: { onClose: () => void; open: boolean; children: React.ReactNode; primaryAction: { onClick: () => void; disabled: boolean } }) => open ? <div>{children}<button onClick={onClose}>Close</button><button disabled={primaryAction.disabled} onClick={primaryAction.onClick}>Submit</button></div> : null }));
vi.mock("@/components/ui/input", () => ({ Select: (props: React.ComponentProps<"select">) => <select {...props} /> }));
vi.mock("@/components/portal/popup-live-preview", () => ({ PopupMessagePreview: () => null, PopupRecordPreview: () => null }));
vi.mock("@/components/portal/portal-message-compose-fields", () => ({
  portalMessageFieldLabel: () => "",
  PortalMessageComposeModalBody: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PortalMessageSubjectField: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <input aria-label="Subject" value={value} onChange={(event) => onChange(event.target.value)} />,
  PortalMessageBodyField: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <textarea aria-label="Message" value={value} onChange={(event) => onChange(event.target.value)} />,
  PortalMessageScheduleFields: () => null,
}));
const person = { id: "manager-1", name: "Test manager", email: "manager@example.test" };
const recipients = { managers: [person], residents: [] };
const sent = vi.fn();
const close = vi.fn();
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/admin/communication/active");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function compose(props: Partial<React.ComponentProps<typeof AdminComposeModal>> = {}) {
  const result = render(<AdminComposeModal open onClose={close} onSent={sent} recipients={recipients} {...props} />);
  await act(async () => {});
  fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Subject draft" } });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Message draft" } });
  return result;
}
describe("admin sends authorize before appending", () => {
  it("awaits acceptance, deduplicates recipients and ignores duplicate pending submits", async () => {
    let accept!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => { accept = resolve; }));
    await compose({ recipients: { managers: [person, person], residents: [person] } });
    fireEvent.change(screen.getByLabelText("Recipient type"), { target: { value: "all_portal" } });
    fireEvent.click(screen.getByText("Submit"));
    fireEvent.click(screen.getByText("Submit"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.append).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(url, "https://example.test").searchParams.get("oversight")).toBe("admin");
    expect(JSON.parse(init.body)).toMatchObject({ toUserIds: [person.id], deliverViaEmail: false });
    await act(async () => { accept(Response.json({ ok: true })); });
    expect(mocks.append).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("keeps a reopened draft when an older pending send succeeds", async () => {
    let accept!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { accept = resolve; }));
    const result = await compose();
    fireEvent.click(screen.getByText("Submit"));
    fireEvent.click(screen.getByText("Close"));
    expect(close).toHaveBeenCalledTimes(1);
    result.rerender(<AdminComposeModal open={false} onClose={close} onSent={sent} recipients={recipients} />);
    result.rerender(<AdminComposeModal open onClose={close} onSent={sent} recipients={recipients} />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "New subject" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "New draft" } });
    await act(async () => { accept(Response.json({ ok: true })); });
    expect(mocks.append).toHaveBeenCalledTimes(1);
    expect(mocks.append).toHaveBeenCalledWith(expect.objectContaining({ topic: "Subject draft", body: "Message draft" }));
    expect(sent).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("New subject");
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("New draft");
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    fireEvent.click(screen.getByText("Submit"));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    expect(mocks.append).toHaveBeenLastCalledWith(expect.objectContaining({ topic: "New subject", body: "New draft" }));
  });
  it("allows retrying a retained draft after a failed send", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false })).mockResolvedValueOnce(Response.json({ ok: true }));
    await compose();
    fireEvent.click(screen.getByText("Submit"));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Message could not be sent."));
    fireEvent.click(screen.getByText("Submit"));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.append).toHaveBeenCalledTimes(1);
  });
  it.each(["403", "500", "network", "invalid-json", "false", "null"])("keeps the draft and no Sent row after %s", async (failure) => {
    fetchMock.mockImplementation(async () => {
      if (failure === "network") throw new Error("Network failure");
      if (failure === "invalid-json") return new Response("invalid");
      if (failure === "null") return Response.json(null);
      return Response.json({ ok: failure !== "false" }, { status: failure === "403" ? 403 : failure === "500" ? 500 : 200 });
    });
    await compose();
    fireEvent.click(screen.getByText("Submit"));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Message could not be sent."));
    expect(mocks.append).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Subject draft");
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Message draft");
  });
  it.each([false, true])("blocks unresolved and empty recipients for schedule=%s", async (initialSchedule) => {
    const result = await compose({ recipientsStatus: "loading", initialSchedule });
    expect((screen.getByText("Submit") as HTMLButtonElement).disabled).toBe(true);
    result.rerender(<AdminComposeModal open onClose={close} onSent={sent} recipients={{ managers: [], residents: [] }} initialSchedule={initialSchedule} />);
    fireEvent.change(screen.getByLabelText("Recipient type"), { target: { value: "all_managers" } });
    expect((screen.getByText("Submit") as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
  });
  it("schedules deduplicated ready recipients through the existing scheduled-send path", async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    await compose({ initialSchedule: true, recipients: { managers: [person], residents: [person] } });
    fireEvent.change(screen.getByLabelText("Recipient type"), { target: { value: "all_portal" } });
    fireEvent.click(screen.getByText("Submit"));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/portal/scheduled-inbox-messages");
    expect(mocks.append).not.toHaveBeenCalled();
    expect(sent).toHaveBeenCalledTimes(1);
  });
  it("blocks malformed recipient data", async () => {
    await compose({ recipients: { managers: [{ ...person, email: "" }], residents: [] } });
    expect((screen.getByText("Submit") as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("blocks selections that disappeared from the current recipient pool", async () => {
    const result = await compose();
    result.rerender(<AdminComposeModal open onClose={close} onSent={sent} recipients={{ managers: [{ ...person, id: "replacement" }], residents: [] }} />);
    expect((screen.getByText("Submit") as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
