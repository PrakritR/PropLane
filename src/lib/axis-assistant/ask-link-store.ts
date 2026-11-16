"use client";

import { useEffect, useSyncExternalStore } from "react";
import { parseAskRecordParam, type AskRecordKind } from "@/lib/communication/deep-links";
import { openAxisAssistant } from "@/lib/axis-assistant/open-store";

/**
 * "Ask PropLane about this": a notice's link may carry `?ask=<kind>:<id>`. The portal opens the one assistant surface (the
 * side panel, or the full-screen sheet on a phone) already pointed at that record. The param is a REFERENCE only: it becomes
 * a context hint that names the record and tells the assistant to read it through its own tools, which re-authorize the
 * viewer (an unauthorized reference reads nothing). It is never a prompt the server executes; the person types the question.
 */
let hint: string | null = null;
const listeners = new Set<() => void>();

export function askContextHintFor(kind: AskRecordKind, id: string): string {
  return kind === "thread"
    ? `Communication thread ${id}. The person opened this from a link. Read the conversation with get_thread_messages (thread id ${id}) before answering; if it cannot be read, say so.`
    : `${kind} ${id}. The person opened this from a link. Read it with your tools before answering; if it cannot be read, say so.`;
}

export function setAskLinkHint(next: string | null): void {
  if (hint === next) return;
  hint = next;
  for (const listener of listeners) listener();
}

export function getAskLinkHint(): string | null {
  return hint;
}

export function useAskLinkHint(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAskLinkHint,
    () => null,
  );
}

/** Mount once per portal: reads `?ask=` on arrival, opens the assistant about that record, and drops the param. */
export function useAskPropLaneLink(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const ref = parseAskRecordParam(url.searchParams.get("ask"));
    if (!ref) return;
    setAskLinkHint(askContextHintFor(ref.kind, ref.id));
    openAxisAssistant();
    url.searchParams.delete("ask");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
}
