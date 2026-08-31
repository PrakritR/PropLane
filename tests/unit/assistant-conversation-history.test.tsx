// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";

import { AssistantConversationProvider, useOptionalAssistantConversation } from "@/lib/axis-assistant/assistant-conversation-context";
import { useAssistantConversation } from "@/lib/axis-assistant/use-assistant-conversation";

const ENDPOINT = "/api/agent/chat";
const LATEST = "10000000-0000-4000-8000-000000000001";
const OLDER = "10000000-0000-4000-8000-000000000002";
const FRESH = "10000000-0000-4000-8000-000000000003";

function response(body: Record<string, unknown>, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function installArchiveFetch(includeThreads = true) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return response({ deleted: true });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { newSession?: boolean };
      if (body.newSession) return response({ sessionId: FRESH });
      return response({ reply: "Saved server reply.", sessionId: FRESH, toolTrace: [] });
    }
    if (url.includes(`sessionId=${OLDER}`)) {
      return response({
        conversation: {
          id: OLDER,
          messages: [{ role: "user", content: "Older question" }, { role: "assistant", content: "Older answer" }],
          pendingAction: {
            id: "pending-older",
            preview: { kind: "schedule_message", title: "Schedule", confirmLabel: "Confirm", fields: [] },
          },
        },
      });
    }
    if (url.includes(`sessionId=${LATEST}`)) {
      return response({
        conversation: {
          id: LATEST,
          messages: [{ role: "user", content: "Latest question" }, { role: "assistant", content: "Latest answer" }],
          pendingAction: null,
        },
      });
    }
    if (url.includes("search=Older")) {
      return response({
        threads: [{ id: OLDER, title: "Older question", updatedAt: "2026-08-03T12:00:00.000Z" }],
        nextCursor: null,
      });
    }
    return response(
      includeThreads
        ? {
            threads: [
              { id: LATEST, title: "Latest question", updatedAt: "2026-08-04T12:00:00.000Z" },
              { id: OLDER, title: "Older question", updatedAt: "2026-08-03T12:00:00.000Z" },
            ],
            nextCursor: null,
          }
        : { threads: [], nextCursor: null },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("server-backed assistant conversation history", () => {
  it("hydrates the latest archive session, starts a blank chat, and restores a selected transcript plus live preview", async () => {
    const fetchMock = installArchiveFetch();
    const { result } = renderHook(() => useAssistantConversation(ENDPOINT));

    await act(async () => {
      await result.current.hydrateArchive();
    });
    await waitFor(() => expect(result.current.activeThreadId).toBe(LATEST));
    expect(result.current.messages).toEqual([
      { role: "user", content: "Latest question" },
      { role: "assistant", content: "Latest answer" },
    ]);

    await act(async () => {
      await result.current.startNewChat();
    });
    // New chat is a local reset only — no server thread is created (and nothing
    // is added to Past conversations) until the first message is actually sent.
    expect(result.current.messages).toEqual([]);
    expect(result.current.activeThreadId).toBe("");
    const eagerStart = fetchMock.mock.calls.find(([, init]) => {
      if ((init as RequestInit | undefined)?.method !== "POST") return false;
      const body = JSON.parse(String((init as RequestInit | undefined)?.body)) as { newSession?: boolean };
      return body.newSession === true;
    });
    expect(eagerStart).toBeUndefined();

    await act(async () => {
      await result.current.send("A brand new question");
    });
    const post = fetchMock.mock.calls.find(([, init]) => {
      if ((init as RequestInit | undefined)?.method !== "POST") return false;
      const body = JSON.parse(String((init as RequestInit | undefined)?.body)) as { messages?: unknown[] };
      return Array.isArray(body.messages);
    });
    const sentBody = JSON.parse(String((post?.[1] as RequestInit).body)) as Record<string, unknown>;
    // The first message of a brand-new chat carries no sessionId; the server
    // creates the thread lazily and returns its id in the reply.
    expect(sentBody).toMatchObject({
      archive: true,
      messages: [{ role: "user", content: "A brand new question" }],
    });
    expect(sentBody.sessionId).toBeUndefined();
    await waitFor(() => expect(result.current.activeThreadId).toBe(FRESH));
    expect(result.current.threads[0]).toMatchObject({ id: FRESH, title: "A brand new question" });

    await act(async () => {
      await result.current.selectThread(OLDER);
    });
    expect(result.current.activeThreadId).toBe(OLDER);
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", content: "Older answer" });
    expect(result.current.pendingAction?.id).toBe("pending-older");
  });

  it("gives popup and dock consumers one provider-owned conversation", async () => {
    installArchiveFetch(false);

    function Surface({ name }: { name: string }) {
      const conversation = useOptionalAssistantConversation();
      return (
        <section>
          <button type="button" onClick={() => void conversation.send("Shared question")}>
            Send from {name}
          </button>
          <p data-testid={`${name}-messages`}>{conversation.messages.map((message) => message.content).join(" | ")}</p>
          <p data-testid={`${name}-pending`}>{conversation.pendingAction?.id ?? "none"}</p>
        </section>
      );
    }

    render(
      <AssistantConversationProvider endpoint={ENDPOINT}>
        <Surface name="popup" />
        <Surface name="dock" />
      </AssistantConversationProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send from popup" }));
    await waitFor(() => expect(screen.getByTestId("dock-messages")).toHaveTextContent("Shared question | Saved server reply."));
    expect(screen.getByTestId("popup-messages")).toHaveTextContent("Shared question | Saved server reply.");
    expect(screen.getByTestId("dock-pending")).toHaveTextContent("none");
  });

  it("does not let a late initial archive read replace a newly started chat", async () => {
    let releaseInitialList: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(response({ reply: "Fresh reply.", sessionId: FRESH, toolTrace: [] }));
      if (url.includes("sessionId=")) return Promise.resolve(response({ error: "Should not load an old transcript." }, 500));
      return new Promise<Response>((resolve) => {
        releaseInitialList = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useAssistantConversation(ENDPOINT));
    act(() => {
      void result.current.hydrateArchive();
    });
    await waitFor(() => expect(releaseInitialList).toBeTypeOf("function"));

    await act(async () => {
      await result.current.send("Do not replace me");
    });
    releaseInitialList?.(
      response({
        threads: [{ id: LATEST, title: "Earlier chat", updatedAt: "2026-08-04T12:00:00.000Z" }],
        nextCursor: null,
      }),
    );

    await waitFor(() => expect(result.current.activeThreadId).toBe(FRESH));
    expect(result.current.messages).toEqual([
      { role: "user", content: "Do not replace me" },
      { role: "assistant", content: "Fresh reply." },
    ]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("sessionId="))).toBe(false);
  });

  it("searches server-backed conversations while preserving the shared search state", async () => {
    const fetchMock = installArchiveFetch();
    vi.useFakeTimers();
    const { result } = renderHook(() => useAssistantConversation(ENDPOINT));

    await act(async () => {
      await result.current.hydrateArchive();
    });
    act(() => {
      result.current.searchHistory("Older");
    });
    expect(result.current.historySearch).toBe("Older");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("search=Older"))).toBe(true);
    expect(result.current.threads).toEqual([
      expect.objectContaining({ id: OLDER, title: "Older question" }),
    ]);
  });

  it("removes a deleted conversation from the shared archive", async () => {
    installArchiveFetch();
    const { result } = renderHook(() => useAssistantConversation(ENDPOINT));

    await act(async () => {
      await result.current.hydrateArchive();
    });
    await act(async () => {
      await result.current.deleteThread(OLDER);
    });

    expect(result.current.threads).not.toContainEqual(expect.objectContaining({ id: OLDER }));
  });
});
