// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssistantPauseControl, assistantPauseConversationId } from "@/components/portal/assistant-pause-control";

const ID = "11111111-1111-4111-8111-111111111111";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AssistantPauseControl", () => {
  it("renders nothing when the thread state is not found", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(404, { error: "Conversation not found." }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<AssistantPauseControl conversationId={ID} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders nothing without a conversation id", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<AssistantPauseControl conversationId={null} />);
    expect(container.querySelector("button")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows Pause assistant when running and POSTs pause", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { paused: false }))
      .mockResolvedValueOnce(json(200, { paused: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AssistantPauseControl conversationId={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause assistant" }));
    await screen.findByRole("button", { name: "Resume assistant" });
    const [, init] = fetchMock.mock.calls[1]!;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ conversationId: ID, action: "pause" });
  });

  it("shows Resume assistant when paused and POSTs resume", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { paused: true }))
      .mockResolvedValueOnce(json(200, { paused: false }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AssistantPauseControl conversationId={ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume assistant" }));
    await screen.findByRole("button", { name: "Pause assistant" });
    const [, init] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(init.body)).toEqual({ conversationId: ID, action: "resume" });
  });
});

describe("assistantPauseConversationId", () => {
  it("excludes managers and rows without a projection id", () => {
    expect(assistantPauseConversationId({ projectionId: ID, counterpartyRole: "resident" })).toBe(ID);
    expect(assistantPauseConversationId({ projectionId: ID, counterpartyRole: "manager" })).toBeNull();
    expect(assistantPauseConversationId({ counterpartyRole: "resident" })).toBeNull();
    expect(assistantPauseConversationId(null)).toBeNull();
  });
});
