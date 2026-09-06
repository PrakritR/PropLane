"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  attachmentsToApiPayload,
  revokeAttachmentPreview,
  userMessageContentFromInput,
  type PendingChatAttachment,
} from "@/lib/assistant-chat-attachments.client";
import {
  clearAssistantChatMessages,
  loadAssistantChatMessages,
  saveAssistantChatMessages,
} from "@/lib/axis-assistant/assistant-chat-storage";
import { notifyAgentPendingActionsChanged } from "@/lib/axis-assistant/pending-actions-events";
import {
  notifyFinancesAssistantUpdated,
  postedDateFromPreviewFields,
} from "@/lib/finances-assistant-events";
import { notifyListingAssistantUpdated } from "@/lib/listing-assistant-events";
import { syncManagerOutgoingExpensesFromServer } from "@/lib/manager-outgoing-payments";
import { agentChatThreadTitleFromPrompts } from "@/lib/agent/chat-title";

/**
 * `traceId` is the Langfuse trace behind an assistant reply. It is what a thumbs
 * rating attaches to, so only assistant messages carry one, and only when
 * Langfuse is configured — a message without it renders no rating control.
 * Deliberately NOT sent back up as conversation history: the server re-derives
 * every turn, and the feedback route re-verifies ownership server-side.
 */
export type ChatMessage = { role: "user" | "assistant"; content: string; traceId?: string; attachmentContext?: string };

export function visibleConversationMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.role === "user" || message.content.trim().length > 0);
}

export function completedAssistantTurnMessages(
  prior: ChatMessage[],
  reply: string | undefined,
  traceId?: string,
): ChatMessage[] {
  const content = reply?.trim() ?? "";
  if (!content) return prior;
  return [...prior, { role: "assistant", content, ...(traceId ? { traceId } : {}) }];
}
export type ToolTraceEntry = { tool: string; ok: boolean };
export type AssistantChatThreadSummary = { id: string; title: string; updatedAt: string };

/** The preview from the server's confirm gate. Its input never reaches the browser. */
export type ActionPreview = {
  kind: string;
  title: string;
  confirmLabel: string;
  fields: { label: string; value: string }[];
  warnings?: string[];
};
export type PendingAction = { id: string; preview: ActionPreview };

type AssistantTransportData = {
  reply?: string;
  toolTrace?: ToolTraceEntry[];
  pendingAction?: PendingAction;
  error?: string;
  sessionId?: string | null;
  traceId?: string;
  archiveSaved?: boolean;
  attachmentContext?: string;
};

/** Parse the SSE transport while retaining JSON compatibility for older routes. */
async function readAssistantTransport(
  res: Response,
  onDelta: (text: string) => void,
): Promise<AssistantTransportData> {
  const contentType = res.headers?.get?.("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || !res.body) {
    return (await res.json()) as AssistantTransportData;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";
  let pendingAction: PendingAction | undefined;
  let done: AssistantTransportData = {};
  const consume = (record: string) => {
    const event = record.match(/^event:\s*(.+)$/m)?.[1]?.trim();
    const data = record.match(/^data:\s*(.+)$/m)?.[1];
    if (!event || !data) return;
    let parsed: (AssistantTransportData & { text?: string }) | { text?: string };
    try {
      parsed = JSON.parse(data) as AssistantTransportData & { text?: string };
    } catch {
      return;
    }
    if (event === "delta" && "text" in parsed && typeof parsed.text === "string") {
      reply += parsed.text;
      onDelta(parsed.text);
    } else if (event === "pending_action") {
      pendingAction = parsed as PendingAction;
    } else if (event === "done") {
      done = parsed as AssistantTransportData;
    }
  };
  while (true) {
    const { done: finished, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !finished });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
    if (finished) break;
  }
  return { ...done, reply, pendingAction };
}

type HistoryListResponse = {
  threads?: AssistantChatThreadSummary[];
  nextCursor?: string | null;
  error?: string;
};

type TranscriptResponse = {
  conversation?: {
    id: string;
    messages: ChatMessage[];
    pendingAction?: PendingAction | null;
  };
  error?: string;
};
type DeleteSessionResponse = { deleted?: boolean; error?: string };
function isRetryableConfirmStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function threadTitleFromMessages(messages: ChatMessage[]): string {
  return agentChatThreadTitleFromPrompts(messages.filter((message) => message.role === "user").map((message) => message.content));
}

function upsertThread(
  threads: AssistantChatThreadSummary[],
  sessionId: string,
  messages: ChatMessage[],
): AssistantChatThreadSummary[] {
  const updatedAt = new Date().toISOString();
  const next = { id: sessionId, title: threadTitleFromMessages(messages), updatedAt };
  return [next, ...threads.filter((thread) => thread.id !== sessionId)].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  );
}

/**
 * One headless transport for every assistant presentation. Portal-wide popup
 * and dock chats use the authenticated server archive; task-bound modal strips
 * keep their existing isolated local thread and are tagged out of that archive.
 */
export type AssistantConversationOptions = {
  /** Isolates modal threads from the portal-wide archive. */
  storageScope?: string;
};

export function useAssistantConversation(endpoint: string, options: AssistantConversationOptions = {}) {
  const storageScope = options.storageScope?.trim() || undefined;
  const multiThread = !storageScope;
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<PendingChatAttachment[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    storageScope ? visibleConversationMessages(loadAssistantChatMessages(endpoint, storageScope)) : [],
  );
  /** traceId -> the rating this user gave it, so the control reflects the choice. */
  const [ratings, setRatings] = useState<Record<string, "up" | "down">>({});
  const [activeThreadId, setActiveThreadId] = useState("");
  const [threads, setThreads] = useState<AssistantChatThreadSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historySearch, setHistorySearch] = useState("");
  const [nextHistoryCursor, setNextHistoryCursor] = useState<string | null>(null);
  const [lastTools, setLastTools] = useState<ToolTraceEntry[]>([]);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [loading, setLoading] = useState(false);
  const requestInFlight = useRef(false);
  const conversationGeneration = useRef(0);
  const disposed = useRef(false);
  const taskPendingIds = useRef(new Set<string>());

  const denyDisposedTaskAction = useCallback(async (actionId: string) => {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ denyActionId: actionId }),
        keepalive: true,
      });
      if (!response.ok) console.warn("Could not discard the closed assistant's pending action.");
    } catch {
      console.warn("Could not discard the closed assistant's pending action.");
    } finally {
      notifyAgentPendingActionsChanged();
    }
  }, [endpoint]);

  useEffect(() => {
    disposed.current = false;
    const pendingIds = taskPendingIds.current;
    return () => {
      disposed.current = true;
      conversationGeneration.current += 1;
      if (!multiThread) {
        for (const actionId of pendingIds) void denyDisposedTaskAction(actionId);
        pendingIds.clear();
      }
    };
  }, [denyDisposedTaskAction, multiThread]);
  const [error, setError] = useState<string | null>(null);
  // An archive read can finish after the user begins a new thread. Never let
  // that late response replace the interaction they just started.
  const hasInteractedWithConversation = useRef(false);
  const historySearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchThreadList = useCallback(
    async (
      cursor?: string | null,
      append = false,
      search = "",
      replaceThreads = false,
    ): Promise<AssistantChatThreadSummary[]> => {
      if (!multiThread) return [];
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const url = new URL(endpoint, window.location.origin);
        if (cursor) url.searchParams.set("cursor", cursor);
        const normalizedSearch = search.trim();
        if (normalizedSearch) url.searchParams.set("search", normalizedSearch);
        const res = await fetch(url.pathname + url.search, { credentials: "include", cache: "no-store" });
        const data = (await res.json()) as HistoryListResponse;
        if (!res.ok || data.error) throw new Error(data.error ?? "Could not load conversations.");
        const incoming = data.threads ?? [];
        setThreads((current) => {
          if (!append && (replaceThreads || !hasInteractedWithConversation.current)) return incoming;
          const existing = new Map(current.map((thread) => [thread.id, thread]));
          for (const thread of incoming) existing.set(thread.id, thread);
          return [...existing.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        });
        setNextHistoryCursor(data.nextCursor ?? null);
        return incoming;
      } catch (cause) {
        setHistoryError(cause instanceof Error ? cause.message : "Could not load conversations.");
        return [];
      } finally {
        setHistoryLoading(false);
      }
    },
    [endpoint, multiThread],
  );

  const fetchTranscript = useCallback(
    async (threadId: string): Promise<TranscriptResponse["conversation"] | null> => {
      const url = new URL(endpoint, window.location.origin);
      url.searchParams.set("sessionId", threadId);
      const res = await fetch(url.pathname + url.search, { credentials: "include", cache: "no-store" });
      const data = (await res.json()) as TranscriptResponse;
      if (!res.ok || data.error || !data.conversation) {
        throw new Error(data.error ?? "Could not load that conversation.");
      }
      return data.conversation;
    },
    [endpoint],
  );

  // The portal layout mounts this provider even when the assistant stays
  // closed. Delay the private archive read until a user opens the popup, sees
  // a dock, or asks for history; otherwise every portal page view would spend
  // a Supabase request without any assistant interaction.
  const archiveHydrated = useRef(false);
  const archiveLoadInFlight = useRef<Promise<void> | null>(null);
  const hydrateArchive = useCallback(async () => {
    if (!multiThread || archiveHydrated.current) return;
    if (archiveLoadInFlight.current) return archiveLoadInFlight.current;
    const load = (async () => {
      const initialThreads = await fetchThreadList();
      archiveHydrated.current = true;
      if (hasInteractedWithConversation.current || initialThreads.length === 0) return;
      try {
        const conversation = await fetchTranscript(initialThreads[0]!.id);
        if (hasInteractedWithConversation.current || !conversation) return;
        setActiveThreadId(conversation.id);
        setMessages(visibleConversationMessages(conversation.messages));
        setPendingAction(conversation.pendingAction ?? null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not restore your latest conversation.");
      }
    })();
    archiveLoadInFlight.current = load;
    try {
      await load;
    } finally {
      archiveLoadInFlight.current = null;
    }
  }, [fetchThreadList, fetchTranscript, multiThread]);

  useEffect(() => {
    if (!multiThread) saveAssistantChatMessages(endpoint, visibleConversationMessages(messages), storageScope);
  }, [endpoint, messages, multiThread, storageScope]);

  useEffect(
    () => () => {
      if (historySearchTimer.current) clearTimeout(historySearchTimer.current);
    },
    [],
  );

  const resolvePendingAction = useCallback(
    async (decision: "confirm" | "deny") => {
      if (!pendingAction || loading || requestInFlight.current) return;
      requestInFlight.current = true;
      const generation = conversationGeneration.current;
      const confirmedKind = pendingAction.preview.kind;
      const listingIdForRefresh = pendingAction.preview.fields.find((field) => field.label === "Listing id")?.value?.trim();
      setError(null);
      setLoading(true);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(decision === "confirm" ? { confirmActionId: pendingAction.id } : { denyActionId: pendingAction.id }),
        });
        const data = (await res.json()) as { reply?: string; toolTrace?: ToolTraceEntry[]; error?: string };
        if (disposed.current || generation !== conversationGeneration.current) return;
        if (!res.ok || data.error) {
          setError(data.error ?? "Could not complete that action.");
          if (!isRetryableConfirmStatus(res.status)) {
            taskPendingIds.current.delete(pendingAction.id);
            setPendingAction(null);
          }
        } else {
          taskPendingIds.current.delete(pendingAction.id);
          setMessages((current) => [...current, { role: "assistant", content: data.reply ?? "Done." }]);
          setLastTools(data.toolTrace ?? []);
          setPendingAction(null);
          if (decision === "confirm" && confirmedKind === "apply_listing_photos" && listingIdForRefresh) {
            notifyListingAssistantUpdated({ propertyId: listingIdForRefresh, tool: "apply_listing_photos" });
          }
          if (decision === "confirm" && (confirmedKind === "record_expense" || confirmedKind === "record_income")) {
            notifyFinancesAssistantUpdated({
              tool: confirmedKind,
              postedDate: postedDateFromPreviewFields(pendingAction.preview.fields),
            });
            void syncManagerOutgoingExpensesFromServer(true);
          }
        }
      } catch {
        if (!disposed.current && generation === conversationGeneration.current) setError("Network error.");
      } finally {
        if (!disposed.current && generation === conversationGeneration.current) {
          requestInFlight.current = false;
          setLoading(false);
        }
        notifyAgentPendingActionsChanged();
      }
    },
    [endpoint, loading, pendingAction],
  );

  const send = useCallback(
    async (prompt?: string, requestContext?: { contextHint?: string | null }) => {
      const text = userMessageContentFromInput(prompt ?? input, attachments);
      if (!text || loading || requestInFlight.current) return;
      // Only the author's standalone command can approve the visible message.
      // Context, attachments, edits and model output never enter this decision.
      if (attachments.length === 0 && pendingAction &&
          ["send_message", "reply_to_thread", "send_message_to_manager"].includes(pendingAction.preview.kind) &&
          /^(?:send|send it|send the message|send the reply)[.!]?$/i.test(text.trim())) {
        setInput("");
        await resolvePendingAction("confirm");
        return;
      }
      requestInFlight.current = true;
      const generation = conversationGeneration.current;
      hasInteractedWithConversation.current = true;
      setError(null);
      let hadPending = false;
      setPendingAction((previous) => {
        hadPending = previous !== null;
        return null;
      });
      const attachmentPayload = attachmentsToApiPayload(attachments);
      const next: ChatMessage[] = [...messages, { role: "user", content: text }];
      setMessages(next);
      setInput("");
      const sentAttachments = attachments;
      setAttachments([]);
      setLoading(true);
      setLastTools([]);
      let streamingAssistant = false;
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({
            messages: next.map(message => ({ ...message, content: message.attachmentContext ? `${message.attachmentContext}\n\n${message.content}` : message.content })),
            ...(activeThreadId ? { sessionId: activeThreadId } : {}),
            archive: multiThread,
            ...(requestContext?.contextHint?.trim() ? { contextHint: requestContext.contextHint.trim() } : {}),
            ...attachmentPayload,
          }),
        });
        const data = await readAssistantTransport(res, (text) => {
          if (disposed.current || generation !== conversationGeneration.current) return;
          setMessages((current) => {
            if (!streamingAssistant) {
              streamingAssistant = true;
              return [...current, { role: "assistant", content: text }];
            }
            const last = current.length - 1;
            return current.map((message, index) =>
              index === last && message.role === "assistant"
                ? { ...message, content: message.content + text }
                : message,
            );
          });
        });
        if (disposed.current || generation !== conversationGeneration.current) {
          if (!multiThread && data.pendingAction) await denyDisposedTaskAction(data.pendingAction.id);
          return;
        }
        if (!res.ok || data.error) {
          setError(data.error ?? "Something went wrong.");
          setAttachments(sentAttachments);
        } else {
          // The stream can populate a provisional reply. Replacing it with the
          // completed transport payload guarantees that the archived thread and
          // local state agree, while retaining the optional Langfuse trace id.
          // The server may report what it read out of an attachment; stamp that on the user
          // turn it belongs to. The reply itself still goes through
          // completedAssistantTurnMessages, so an empty one is dropped rather than archived
          // as a blank assistant bubble.
          const withContext = data.attachmentContext
            ? next.map((message, index) => index === next.length - 1
              ? { ...message, attachmentContext: data.attachmentContext }
              : message)
            : next;
          const completed = completedAssistantTurnMessages(withContext, data.reply, data.traceId);
          setMessages(completed);
          if (data.sessionId) {
            setActiveThreadId(data.sessionId);
            if (multiThread) setThreads((current) => upsertThread(current, data.sessionId!, completed));
          }
          setLastTools(data.toolTrace ?? []);
          setPendingAction(data.pendingAction ?? null);
          if (!multiThread && data.pendingAction) taskPendingIds.current.add(data.pendingAction.id);
          if (multiThread && data.archiveSaved === false) {
            setError("This reply could not be saved to Past conversations. Please send it again.");
          }
          if (data.pendingAction || hadPending) notifyAgentPendingActionsChanged();
        }
      } catch {
        if (!disposed.current && generation === conversationGeneration.current) {
          setError("Network error.");
          setAttachments(sentAttachments);
        }
      } finally {
        if (!disposed.current && generation === conversationGeneration.current) {
          requestInFlight.current = false;
          setLoading(false);
        }
      }
    },
    [activeThreadId, attachments, denyDisposedTaskAction, endpoint, input, loading, messages, multiThread, pendingAction, resolvePendingAction],
  );


  const reset = useCallback(() => {
    conversationGeneration.current += 1;
    requestInFlight.current = false;
    setLoading(false);
    if (!multiThread) {
      for (const actionId of taskPendingIds.current) void denyDisposedTaskAction(actionId);
      taskPendingIds.current.clear();
    }
    hasInteractedWithConversation.current = true;
    attachments.forEach(revokeAttachmentPreview);
    setActiveThreadId("");
    setMessages([]);
    if (!multiThread) clearAssistantChatMessages(endpoint, storageScope);
    setLastTools([]);
    setPendingAction(null);
    setError(null);
    setInput("");
    setAttachments([]);
    setHistoryOpen(false);
    setHistorySearch("");
    if (historySearchTimer.current) clearTimeout(historySearchTimer.current);
  }, [attachments, denyDisposedTaskAction, endpoint, multiThread, storageScope]);

  const startNewChat = useCallback(async () => {
    // A brand-new chat is a local reset only. The server thread is created
    // lazily on the first message (see `send`), so an empty conversation the
    // user opens but never types into is never saved or shown in history.
    reset();
  }, [reset]);

  const openHistory = useCallback(() => {
    if (!multiThread) return;
    setHistoryOpen(true);
    if (archiveHydrated.current) void fetchThreadList(undefined, false, historySearch, Boolean(historySearch.trim()));
    else void hydrateArchive();
  }, [fetchThreadList, historySearch, hydrateArchive, multiThread]);

  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  const searchHistory = useCallback(
    (value: string) => {
      setHistorySearch(value);
      if (!multiThread) return;
      if (historySearchTimer.current) clearTimeout(historySearchTimer.current);
      historySearchTimer.current = setTimeout(() => {
        void fetchThreadList(undefined, false, value, true);
      }, 200);
    },
    [fetchThreadList, multiThread],
  );

  /**
   * Rate one assistant turn. Optimistic: the button state is local and the
   * score is fire-and-forget, because a rating is a nice-to-have signal and
   * blocking the UI on it (or surfacing an error toast) would cost more
   * feedback than the occasional lost score does. Returns whether it stuck so a
   * caller that wants to react can.
   */
  const submitFeedback = useCallback(
    async (traceId: string, rating: "up" | "down"): Promise<boolean> => {
      if (!traceId) return false;
      setRatings((r) => ({ ...r, [traceId]: rating }));
      try {
        const res = await fetch("/api/agent/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ traceId, rating }),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    [],
  );

  const selectThread = useCallback(
    async (threadId: string) => {
      if (!multiThread || loading || threadId === activeThreadId) return;
      hasInteractedWithConversation.current = true;
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const conversation = await fetchTranscript(threadId);
        if (!conversation) return;
        setActiveThreadId(conversation.id);
        setMessages(visibleConversationMessages(conversation.messages));
        setPendingAction(conversation.pendingAction ?? null);
        setLastTools([]);
        setError(null);
      } catch (cause) {
        setHistoryError(cause instanceof Error ? cause.message : "Could not load that conversation.");
      } finally {
        setHistoryLoading(false);
      }
    },
    [activeThreadId, fetchTranscript, loading, multiThread],
  );

  const deleteThread = useCallback(
    async (threadId: string): Promise<boolean> => {
      if (!multiThread || loading) return false;
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const url = new URL(endpoint, window.location.origin);
        url.searchParams.set("sessionId", threadId);
        const res = await fetch(url.pathname + url.search, { method: "DELETE", credentials: "include" });
        const data = (await res.json()) as DeleteSessionResponse;
        if (!res.ok || !data.deleted || data.error) {
          throw new Error(data.error ?? "Could not delete that conversation.");
        }
        setThreads((current) => current.filter((thread) => thread.id !== threadId));
        if (threadId === activeThreadId) {
          attachments.forEach(revokeAttachmentPreview);
          setActiveThreadId("");
          setMessages([]);
          setAttachments([]);
          setPendingAction(null);
          setLastTools([]);
          setError(null);
        }
        return true;
      } catch (cause) {
        setHistoryError(cause instanceof Error ? cause.message : "Could not delete that conversation.");
        return false;
      } finally {
        setHistoryLoading(false);
      }
    },
    [activeThreadId, attachments, endpoint, loading, multiThread],
  );

  const loadMoreHistory = useCallback(() => {
    if (!nextHistoryCursor || historyLoading) return;
    void fetchThreadList(nextHistoryCursor, true, historySearch);
  }, [fetchThreadList, historyLoading, historySearch, nextHistoryCursor]);

  return {
    input,
    setInput,
    attachments,
    setAttachments,
    messages,
    threads,
    activeThreadId,
    historyOpen,
    historyLoading,
    historyError,
    historySearch,
    hasMoreHistory: Boolean(nextHistoryCursor),
    multiThread,
    lastTools,
    pendingAction,
    loading,
    error,
    setError,
    ratings,
    submitFeedback,
    send,
    resolvePendingAction,
    reset,
    openHistory,
    closeHistory,
    searchHistory,
    selectThread,
    deleteThread,
    loadMoreHistory,
    hydrateArchive,
    startNewChat,
  } as const;
}
