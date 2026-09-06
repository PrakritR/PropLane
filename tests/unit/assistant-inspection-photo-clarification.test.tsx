// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { assistantResponse } from "@/lib/agent/assistant-stream";
import { useAssistantConversation } from "@/lib/axis-assistant/use-assistant-conversation";

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe("inspection photo clarification in an unarchived assistant", () => {
  it.each(["/api/agent/chat", "/api/agent/resident-chat"])("keeps the private photo through the actual SSE and hook transport: %s", async endpoint => {
    const source = "resident/inspection-chat/portal/photo.jpg";
    const attachmentContext = `Private photo source references (not filed yet):\n${source}\nAsk which section before filing.`;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const firstTurn = body.messages.length === 1;
      // Exercise the server SSE encoder and client SSE parser together, rather
      // than using JSON fallback or inserting context directly into hook state.
      return assistantResponse(new Request(`https://example.test${endpoint}`, { headers: init?.headers }), {
        reply: firstTurn ? "Which room section should I file this under?" : "The door section is selected. Please review the filing proposal.",
        toolTrace: [],
        ...(firstTurn ? { attachmentContext } : {}),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useAssistantConversation(endpoint, { storageScope: "modal:inspection-photo" }));

    act(() => result.current.setAttachments([{ id: "photo", kind: "image", fileName: "room.jpg", mediaType: "image/jpeg", dataBase64: "aW1hZ2U=" }]));
    await act(async () => { await result.current.send("Please add this photo to my inspection."); });
    expect(result.current.error).toBeNull();
    expect(result.current.messages[0]).toMatchObject({ content: "Please add this photo to my inspection.", attachmentContext });
    expect(result.current.messages[0].content).not.toContain(source);
    expect(result.current.attachments).toHaveLength(0);

    await act(async () => { await result.current.send("The door section."); });
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const clarification = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(first.archive).toBe(false);
    expect(first.images).toHaveLength(1);
    expect(clarification.archive).toBe(false);
    expect(clarification.images ?? []).toHaveLength(0);
    expect(clarification.messages[0].content).toBe(`${attachmentContext}\n\nPlease add this photo to my inspection.`);
    expect(clarification.messages.at(-1)).toMatchObject({ role: "user", content: "The door section." });
    expect(clarification).not.toHaveProperty("confirmActionId");

    // A further clarification still carries the source once, not a doubled
    // prefix accumulated by replacing visible text with transport text.
    await act(async () => { await result.current.send("Use the move-in report."); });
    const further = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(further.messages[0].content.split(source)).toHaveLength(2);
    expect(result.current.messages[0].content).toBe("Please add this photo to my inspection.");
  });
});
