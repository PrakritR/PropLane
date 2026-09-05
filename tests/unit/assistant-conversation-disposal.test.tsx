// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useAssistantConversation } from "@/lib/axis-assistant/use-assistant-conversation";

const pendingAction = { id: "pending-task", preview: { kind: "send_message", title: "Message", confirmLabel: "Send", fields: [] } };
const reply = () => new Response(JSON.stringify({ reply: "Review this.", pendingAction }), { headers: { "Content-Type": "application/json" } });
const denied = () => new Response(JSON.stringify({ reply: "Cancelled." }));
function bodyOf(call: unknown[]) { return JSON.parse(String((call[1] as RequestInit)?.body ?? "{}")); }
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe("task assistant disposal", () => {
  it("denies a current task proposal through its existing role endpoint on disposal", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => JSON.parse(String(init?.body)).denyActionId ? denied() : reply());
    vi.stubGlobal("fetch", fetchMock);
    const { result, unmount } = renderHook(() => useAssistantConversation("/api/agent/resident-chat", { storageScope: "task" }));
    await act(async () => { await result.current.send("Draft a message"); });
    unmount();
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/agent/resident-chat");
    expect(bodyOf(fetchMock.mock.calls[1]!)).toEqual({ denyActionId: "pending-task" });
    expect(fetchMock.mock.calls[1]?.[1]?.keepalive).toBe(true);
  });

  it("denies a proposal that arrives after its task has unmounted", async () => {
    let complete!: (response: Response) => void;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => JSON.parse(String(init?.body)).denyActionId
      ? Promise.resolve(denied()) : new Promise<Response>((resolve) => { complete = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const { result, unmount } = renderHook(() => useAssistantConversation("/api/agent/chat", { storageScope: "task" }));
    let send!: Promise<void>;
    act(() => { send = result.current.send("Draft a message"); });
    unmount();
    await act(async () => { complete(reply()); await send; });
    expect(bodyOf(fetchMock.mock.calls[1]!)).toEqual({ denyActionId: "pending-task" });
  });

  it("does not resurrect a reset thread when an older request finishes", async () => {
    let complete!: (response: Response) => void;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => JSON.parse(String(init?.body)).denyActionId
      ? Promise.resolve(denied()) : new Promise<Response>((resolve) => { complete = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useAssistantConversation("/api/agent/chat", { storageScope: "task" }));
    let send!: Promise<void>;
    act(() => { send = result.current.send("Draft a message"); });
    act(() => result.current.reset());
    await act(async () => { complete(reply()); await send; });
    expect(result.current.messages).toEqual([]);
    expect(result.current.pendingAction).toBeNull();
    expect(bodyOf(fetchMock.mock.calls[1]!)).toEqual({ denyActionId: "pending-task" });
  });

  it("preserves portal-wide proposals when their presentation unmounts", async () => {
    const fetchMock = vi.fn(async () => reply());
    vi.stubGlobal("fetch", fetchMock);
    const { result, unmount } = renderHook(() => useAssistantConversation("/api/agent/chat"));
    await act(async () => { await result.current.send("Draft a message"); });
    unmount();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
