/**
 * Browser persistence for PropLane Assistant chat history (per agent endpoint).
 * Survives refresh; cleared on explicit reset. Text-only — attachments are not stored.
 */

import type { ChatMessage } from "@/lib/axis-assistant/use-assistant-conversation";

const STORAGE_VERSION = 1;
const MAX_STORED_MESSAGES = 40;

type StoredPayload = {
  v: number;
  messages: ChatMessage[];
};

export function assistantChatStorageKey(endpoint: string, storageScope?: string): string {
  const path = endpoint.trim() || "/api/agent/chat";
  const scope = storageScope?.trim();
  const base = `axis:assistant-chat:v${STORAGE_VERSION}:${path}`;
  return scope ? `${base}:${scope}` : base;
}

/** Stable slug for modal-scoped assistant threads (separate from the main dock/popup chat). */
export function modalAssistantStorageScope(contextKey: string, instance = 0): string {
  const slug =
    contextKey
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "modal";
  return instance > 0 ? `modal:${slug}:${instance}` : `modal:${slug}`;
}

export function loadAssistantChatMessages(endpoint: string, storageScope?: string): ChatMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(assistantChatStorageKey(endpoint, storageScope));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredPayload;
    if (parsed.v !== STORAGE_VERSION || !Array.isArray(parsed.messages)) return [];
    return parsed.messages
      .filter(
        (m): m is ChatMessage =>
          Boolean(m) &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.trim().length > 0,
      )
      .slice(-MAX_STORED_MESSAGES);
  } catch {
    return [];
  }
}

export function saveAssistantChatMessages(
  endpoint: string,
  messages: ChatMessage[],
  storageScope?: string,
): void {
  if (typeof window === "undefined") return;
  try {
    const payload: StoredPayload = {
      v: STORAGE_VERSION,
      messages: messages.slice(-MAX_STORED_MESSAGES),
    };
    window.localStorage.setItem(assistantChatStorageKey(endpoint, storageScope), JSON.stringify(payload));
  } catch {
    /* quota or private mode */
  }
}

export function clearAssistantChatMessages(endpoint: string, storageScope?: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(assistantChatStorageKey(endpoint, storageScope));
    window.localStorage.removeItem(liveThreadKey(endpoint, storageScope));
  } catch {
    /* ignore */
  }
}

/**
 * Past conversations for a task-bound (modal) assistant. The portal-wide
 * assistant keeps its history in the server archive; a modal thread is
 * deliberately tagged out of that archive, so its History lives here, in this
 * browser, keyed by the modal's stable scope (never its per-visit instance).
 */
export type StoredAssistantThread = {
  id: string;
  title: string;
  updatedAt: string;
  messages: ChatMessage[];
};

const MAX_STORED_THREADS = 20;

function scopedHistoryKey(endpoint: string, historyScope: string): string {
  const path = endpoint.trim() || "/api/agent/chat";
  return `axis:assistant-history:v${STORAGE_VERSION}:${path}:${historyScope.trim()}`;
}

/**
 * A fresh id for a thread, minted when the thread starts.
 *
 * It is deliberately NOT derived from the conversation: two threads in the same
 * modal that open with the same prompt are two threads, and a content-derived
 * id made the second one overwrite the first in History (and made Delete remove
 * both). The live thread's id is persisted beside its messages
 * (`loadLiveThreadId`) so a refresh keeps the same thread rather than archiving
 * a duplicate.
 */
export function newScopedThreadId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `local:${uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
}

function liveThreadKey(endpoint: string, storageScope?: string): string {
  return `${assistantChatStorageKey(endpoint, storageScope)}:thread`;
}

/** The id of the thread whose messages are in storage right now, or "" when there is none. */
export function loadLiveThreadId(endpoint: string, storageScope?: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(liveThreadKey(endpoint, storageScope))?.trim() ?? "";
  } catch {
    return "";
  }
}

export function saveLiveThreadId(endpoint: string, threadId: string, storageScope?: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(liveThreadKey(endpoint, storageScope), threadId);
  } catch {
    /* quota or private mode */
  }
}

export function loadScopedThreads(endpoint: string, historyScope: string): StoredAssistantThread[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(scopedHistoryKey(endpoint, historyScope));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { v: number; threads: StoredAssistantThread[] };
    if (parsed.v !== STORAGE_VERSION || !Array.isArray(parsed.threads)) return [];
    return parsed.threads.filter(
      (t) => t && typeof t.id === "string" && Array.isArray(t.messages) && t.messages.length > 0,
    );
  } catch {
    return [];
  }
}

function writeScopedThreads(endpoint: string, historyScope: string, threads: StoredAssistantThread[]): void {
  try {
    window.localStorage.setItem(
      scopedHistoryKey(endpoint, historyScope),
      JSON.stringify({ v: STORAGE_VERSION, threads: threads.slice(0, MAX_STORED_THREADS) }),
    );
  } catch {
    /* quota or private mode */
  }
}

/** Save (or refresh) one thread, under its own id, at the top of this scope's history. */
export function archiveScopedThread(
  endpoint: string,
  historyScope: string,
  messages: ChatMessage[],
  threadId: string,
): void {
  if (typeof window === "undefined") return;
  const visible = messages.filter((m) => m.content.trim().length > 0).slice(-MAX_STORED_MESSAGES);
  const id = threadId.trim();
  // Nothing was said yet, or the caller has no thread: there is nothing to keep.
  if (!id || !visible.some((m) => m.role === "user")) return;
  const title = (visible.find((m) => m.role === "user")?.content.trim() ?? "Conversation").slice(0, 80);
  const next: StoredAssistantThread = { id, title, updatedAt: new Date().toISOString(), messages: visible };
  writeScopedThreads(endpoint, historyScope, [
    next,
    ...loadScopedThreads(endpoint, historyScope).filter((t) => t.id !== id),
  ]);
}

export function deleteScopedThread(endpoint: string, historyScope: string, threadId: string): void {
  if (typeof window === "undefined") return;
  writeScopedThreads(
    endpoint,
    historyScope,
    loadScopedThreads(endpoint, historyScope).filter((t) => t.id !== threadId),
  );
}
