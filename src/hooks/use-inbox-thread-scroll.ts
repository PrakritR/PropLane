"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

const NEAR_BOTTOM_PX = 120;

/** Scroll a thread body to the newest message. Prefer direct scrollTop over scrollIntoView — it stays inside the pane. */
export function scrollInboxThreadToBottom(scroller: HTMLElement) {
  scroller.scrollTop = scroller.scrollHeight;
}

/**
 * Chat-thread scroll contract shared by email (InboxThreadView) and SMS panels.
 *
 * - Opening a conversation lands on the newest message (instant, with layout retries).
 * - A new message in the same thread only follows the tail when the reader is near the bottom.
 */
export function useInboxThreadScroll(threadKey: string | undefined, messageCount: number) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const prevThreadKeyRef = useRef<string | undefined>(undefined);
  const stickToBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }, []);

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    scrollInboxThreadToBottom(el);
  }, []);

  // Thread switch: reset stale position and land at the tail before paint.
  useLayoutEffect(() => {
    const threadChanged = prevThreadKeyRef.current !== threadKey;
    if (!threadChanged) return;
    prevThreadKeyRef.current = threadKey;
    stickToBottomRef.current = true;

    const el = scrollRef.current;
    if (!el) return;

    el.scrollTop = 0;
    jumpToBottom();

    const raf = requestAnimationFrame(() => {
      jumpToBottom();
      requestAnimationFrame(() => {
        jumpToBottom();
      });
    });
    const timer = window.setTimeout(jumpToBottom, 120);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [threadKey, jumpToBottom]);

  // Same thread, new message — follow only when pinned to the bottom.
  useEffect(() => {
    if (prevThreadKeyRef.current !== threadKey) return;
    if (!stickToBottomRef.current) return;
    jumpToBottom();
  }, [messageCount, threadKey, jumpToBottom]);

  // Scheduled cards, images, or late layout — keep the tail visible when pinned.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      jumpToBottom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [threadKey, jumpToBottom]);

  return { scrollRef, endRef, handleScroll };
}
