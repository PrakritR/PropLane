// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TextingWebDemo from "@/components/marketing/texting-web-demo";

const fetchMock = vi.fn();
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const action = { id: "demo", simulated: true, preview: { title: "Send a rent reminder", fields: [{ label: "To", value: "Test Resident" }], confirmLabel: "Send" } };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

function send(text: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Message PropLane demo" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}

describe("homepage live sandbox chat", () => {
  it("opens an accessible modal, shows sandbox status, and requests a live answer only after a message", async () => {
    fetchMock.mockResolvedValue(reply({ reply: "A tour is scheduled for tomorrow." }));
    render(<TextingWebDemo onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "PropLane demo" })).toBeTruthy();
    expect(screen.getByText("Sandbox · Sample data · Actions are previews only")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show upcoming tours" }));
    await screen.findByText("A tour is scheduled for tomorrow.");
    expect(fetchMock).toHaveBeenCalledWith("/api/agent/demo-chat", expect.objectContaining({ method: "POST", credentials: "omit", signal: expect.any(AbortSignal) }));
  });

  it("retries the identical failed turn without duplicating its message", async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: "Please wait a moment." }, 429)).mockResolvedValueOnce(reply({ reply: "Here are the outstanding charges." }));
    render(<TextingWebDemo onClose={vi.fn()} />);
    send("What rent is outstanding?");
    expect(await screen.findByRole("alert")).toHaveTextContent("Please wait a moment.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Here are the outstanding charges.");
    expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);
    expect(screen.getAllByText("What rent is outstanding?")).toHaveLength(1);
  });

  it("shows typing while waiting and aborts the request on close", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const onClose = vi.fn();
    const view = render(<TextingWebDemo onClose={onClose} />);
    send("Hello");
    expect(screen.getByRole("status", { name: "PropLane is replying" })).toBeTruthy();
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "Close demo" }));
    expect(signal.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("uses the same sandbox endpoint for a simulated action, with no real confirmation request", async () => {
    fetchMock.mockResolvedValueOnce(reply({ reply: "Review the reminder.", pendingAction: action }))
      .mockResolvedValueOnce(reply({ reply: "Nothing was actually sent.", status: "executed" }));
    render(<TextingWebDemo onClose={vi.fn()} />);
    send("Remind the resident to pay rent");
    await screen.findByRole("region", { name: "Sandbox action preview" });
    fireEvent.click(screen.getByRole("button", { name: "Try this in sandbox" }));
    await screen.findByText("Nothing was actually sent.");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/agent/demo-chat", "/api/agent/demo-chat"]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ actionId: "demo" });
    expect(screen.queryByRole("region", { name: "Sandbox action preview" })).toBeNull();
  });

  it("refuses a non-simulated action instead of exposing a real confirm button", async () => {
    fetchMock.mockResolvedValue(reply({ reply: "Review", pendingAction: { ...action, id: "real-action", simulated: false } }));
    render(<TextingWebDemo onClose={vi.fn()} />);
    send("Send a reminder");
    expect(await screen.findByRole("alert")).toHaveTextContent("This action isn't available in the sandbox.");
    expect(screen.queryByRole("button", { name: "Try this in sandbox" })).toBeNull();
  });

  it("keeps requests within the API history limit while retaining the visible conversation", async () => {
    fetchMock.mockImplementation(async () => reply({ reply: `Answer ${fetchMock.mock.calls.length}` }));
    render(<TextingWebDemo onClose={vi.fn()} />);
    for (let index = 1; index <= 9; index += 1) {
      send(`Question ${index}`);
      await screen.findByText(`Answer ${index}`);
    }
    const last = JSON.parse(fetchMock.mock.calls[8][1].body);
    expect(last.messages).toHaveLength(16);
    expect(last.messages.at(-1)).toEqual({ role: "user", content: "Question 9" });
    expect(screen.getByText("Question 1")).toBeTruthy();
  });

  it("handles Escape and aborts on unmount without appending a late answer", async () => {
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
    const onClose = vi.fn();
    const view = render(<TextingWebDemo onClose={onClose} />);
    send("Hello");
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => { resolve(reply({ reply: "Late answer" })); });
    expect(signal.aborted).toBe(true);
    expect(screen.queryByText("Late answer")).toBeNull();
  });

  it("clears a failed conversation on restart so a new prompt can be sent", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network unavailable")).mockResolvedValueOnce(reply({ reply: "Ready." }));
    render(<TextingWebDemo onClose={vi.fn()} />);
    send("Old prompt");
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Start a new demo" }));
    expect(screen.queryByText("Old prompt")).toBeNull();
    send("New prompt");
    await waitFor(() => expect(screen.getByText("Ready.")).toBeTruthy());
    expect(fetchMock.mock.calls[1][1].body).not.toContain("Old prompt");
  });
});
