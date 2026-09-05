"use client";

import { createContext, useContext, type ReactNode } from "react";

import {
  useAssistantConversation,
  type ChatMessage,
  type PendingAction,
  type ToolTraceEntry,
  type AssistantChatThreadSummary,
} from "@/lib/axis-assistant/use-assistant-conversation";

export type AssistantConversationValue = {
  input: string;
  setInput: (value: string) => void;
  attachments: import("@/lib/assistant-chat-attachments.client").PendingChatAttachment[];
  setAttachments: (
    value: import("@/lib/assistant-chat-attachments.client").PendingChatAttachment[],
  ) => void;
  messages: ChatMessage[];
  threads: AssistantChatThreadSummary[];
  activeThreadId: string;
  historyOpen: boolean;
  historyLoading: boolean;
  historyError: string | null;
  historySearch: string;
  hasMoreHistory: boolean;
  multiThread: boolean;
  lastTools: ToolTraceEntry[];
  /** traceId -> this user's thumbs rating, so a rated reply keeps showing it. */
  ratings: Record<string, "up" | "down">;
  submitFeedback: (traceId: string, rating: "up" | "down") => Promise<boolean>;
  pendingAction: PendingAction | null;
  loading: boolean;
  error: string | null;
  setError: (message: string | null) => void;
  send: ReturnType<typeof useAssistantConversation>["send"];
  resolvePendingAction: (decision: "confirm" | "deny") => Promise<void>;
  reset: () => void;
  openHistory: () => void;
  closeHistory: () => void;
  searchHistory: (value: string) => void;
  selectThread: (threadId: string) => Promise<void>;
  deleteThread: (threadId: string) => Promise<boolean>;
  loadMoreHistory: () => void;
  hydrateArchive: () => Promise<void>;
  startNewChat: () => Promise<void>;
};

const AssistantConversationContext = createContext<AssistantConversationValue | null>(null);

function AssistantConversationState({
  endpoint,
  storageScope,
  children,
}: {
  endpoint: string;
  storageScope?: string;
  children: ReactNode;
}) {
  const conversation = useAssistantConversation(endpoint, { storageScope });
  return (
    <AssistantConversationContext.Provider value={conversation}>
      {children}
    </AssistantConversationContext.Provider>
  );
}

/** One conversation shared by the popup and the docked right rail (unless storageScope is set). */
export function AssistantConversationProvider({
  endpoint,
  storageScope,
  children,
}: {
  endpoint: string;
  /** Isolates chat history — used for modal strips so they do not inherit the main thread. */
  storageScope?: string;
  children: ReactNode;
}) {
  return (
    <AssistantConversationState key={`${endpoint}:${storageScope ?? "portal-chat"}`} endpoint={endpoint} storageScope={storageScope}>
      {children}
    </AssistantConversationState>
  );
}

/** Shared conversation from {@link AssistantConversationProvider} (popup + dock). */
export function useOptionalAssistantConversation(_endpoint?: string): AssistantConversationValue {
  void _endpoint;
  const shared = useContext(AssistantConversationContext);
  if (!shared) {
    throw new Error("useOptionalAssistantConversation requires AssistantConversationProvider");
  }
  return shared;
}
