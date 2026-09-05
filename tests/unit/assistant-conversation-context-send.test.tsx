// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useAssistantConversation } from "@/lib/axis-assistant/use-assistant-conversation";
import { loadAssistantChatMessages } from "@/lib/axis-assistant/assistant-chat-storage";

function setup(kind = "send_message", confirmStatus = 200) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const confirmation = Boolean(body.confirmActionId);
    return new Response(JSON.stringify(confirmation
      ? confirmStatus === 200 ? { reply: "Message sent." } : { error: "Try again." }
      : { reply: "Review the message.", pendingAction: { id: "proposal-1", preview: {
        kind, title: "Send message", confirmLabel: "Send", fields: [
          { label: "To", value: "Resident" }, { label: "Message", value: "Hello" },
        ],
      } } }), { status: confirmation ? confirmStatus : 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const hook = renderHook(() => useAssistantConversation("/api/agent/chat", { storageScope: "modal:test" }));
  return { ...hook, fetchMock };
}

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe("assistant internal context and typed send", () => {
  it("keeps task context outside visible and persisted messages, retaining authored context-like text", async () => {
    const { result, fetchMock } = setup();
    const authored = "[Context: this is my own text]\nPlease draft a reply";
    await act(async () => { await result.current.send(authored, { contextHint: "INTERNAL_SENTINEL" }); });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.contextHint).toBe("INTERNAL_SENTINEL");
    expect(request.messages).toEqual([{ role: "user", content: authored }]);
    expect(result.current.messages[0]?.content).toBe(authored);
    expect(JSON.stringify(loadAssistantChatMessages("/api/agent/chat", "modal:test"))).not.toContain("INTERNAL_SENTINEL");
  });

  it.each(["send_message", "reply_to_thread", "send_message_to_manager"])("confirms %s with only the current server-owned action id", async (kind) => {
    const { result, fetchMock } = setup(kind);
    await act(async () => { await result.current.send("draft a message"); });
    await act(async () => { await result.current.send("send", { contextHint: "INTERNAL_SENTINEL" }); });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ confirmActionId: "proposal-1" });
    expect(result.current.pendingAction).toBeNull();
    expect(result.current.messages.at(-1)?.content).toBe("Message sent.");
  });

  it.each(["send?", "don't send", "send after changing the date", "please explain send", '"send"'])("does not interpret %s as approval", async (command) => {
    const { result, fetchMock } = setup();
    await act(async () => { await result.current.send("draft a message"); });
    await act(async () => { await result.current.send(command); });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).not.toHaveProperty("confirmActionId");
  });

  it.each(["schedule_message", "send_rent_reminder", "approve_and_pay_work_order", "delete_property"])("does not approve %s on send", async (kind) => {
    const { result, fetchMock } = setup(kind);
    await act(async () => { await result.current.send("prepare an action"); });
    await act(async () => { await result.current.send("send"); });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).not.toHaveProperty("confirmActionId");
  });

  it("does not approve when the user adds an attachment", async () => {
    const { result, fetchMock } = setup();
    await act(async () => { await result.current.send("draft a message"); });
    act(() => result.current.setAttachments([{ id: "attachment", kind: "document", fileName: "note.pdf", mediaType: "application/pdf", dataBase64: "YQ==" }]));
    await act(async () => { await result.current.send("send"); });
    const request = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(request).not.toHaveProperty("confirmActionId");
    expect(request.documents).toHaveLength(1);
  });

  it("does not confirm after the task conversation resets", async () => {
    const { result, fetchMock } = setup();
    await act(async () => { await result.current.send("draft a message"); });
    act(() => result.current.reset());
    await act(async () => { await result.current.send("send"); });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).not.toHaveProperty("confirmActionId");
  });

  it("retains the preview after a retryable send failure", async () => {
    const { result } = setup("send_message", 503);
    await act(async () => { await result.current.send("draft a message"); });
    await act(async () => { await result.current.send("send"); });
    expect(result.current.pendingAction?.id).toBe("proposal-1");
    expect(result.current.error).toBe("Try again.");
  });

  it("coalesces duplicate immediate sends before React renders loading state", async () => {
    const { result, fetchMock } = setup();
    await act(async () => { await result.current.send("draft a message"); });
    await act(async () => { await Promise.all([result.current.send("send"), result.current.send("send")]); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
