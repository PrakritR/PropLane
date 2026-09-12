"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import { track } from "@/lib/analytics/track-client";
import { AssistantChatComposer } from "@/components/portal/assistant-chat-composer";
import { AssistantMarkdown } from "@/components/portal/assistant-markdown";
import {
  attachmentsToApiPayload,
  revokeAttachmentPreview,
  userMessageContentFromInput,
  type PendingChatAttachment,
} from "@/lib/assistant-chat-attachments.client";
import { useIsClient } from "@/hooks/use-is-client";
import {
  closeGeneralAssistant,
  getGeneralAssistantOpen,
  getPortalAssistantPresent,
  openGeneralAssistant,
  subscribeGeneralAssistantOpen,
  subscribePortalAssistantPresence,
} from "@/lib/general-assistant/open-store";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import { usePathname } from "next/navigation";

type ChatMessage = { role: "user" | "assistant"; content: string };
type Suggestion = { label: string; prompt: string };

const SUGGESTIONS: Suggestion[] = [
  { label: "What is PropLane?", prompt: "What is PropLane and who is it for?" },
  { label: "What can it do?", prompt: "What can PropLane do for a property manager?" },
  { label: "How much is it?", prompt: "How does PropLane pricing work?" },
  { label: "How do I start?", prompt: "How do I get started with PropLane?" },
];

function useGeneralOpen() {
  return useSyncExternalStore(subscribeGeneralAssistantOpen, getGeneralAssistantOpen, () => false);
}

function ChatBubbleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M12 3c5 0 9 3.4 9 7.6 0 4.2-4 7.6-9 7.6-1 0-2-.14-2.9-.4L4 20l1.1-3.3C3.8 15.4 3 13.1 3 10.6 3 6.4 7 3 12 3Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M8.5 10.6h7M8.5 13.4h4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function openAssistant() {
  track("general_assistant_opened");
  openGeneralAssistant();
}

/**
 * Named header entry (auth chrome, legacy). Public marketing pages use
 * {@link GeneralAssistantFab} in the bottom-right instead.
 */
export function GeneralAssistantTrigger() {
  const open = useGeneralOpen();

  function toggleAssistant() {
    if (open) {
      closeGeneralAssistant();
      return;
    }
    openAssistant();
  }

  return (
    <button
      type="button"
      onClick={toggleAssistant}
      data-attr="general-assistant-open"
      aria-label={open ? "Close PropLane Assistant" : "Ask PropLane"}
      aria-expanded={open}
      className="group flex min-h-10 items-center gap-2 rounded-full border border-border bg-card px-3 py-2 text-[13px] font-medium text-muted outline-none transition hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <ChatBubbleIcon className="h-4 w-4 shrink-0 text-primary" />
      <span className="tracking-[-0.01em]">Ask PropLane</span>
    </button>
  );
}

/**
 * Marketing pages carry no floating control (site round 2 §5): the story,
 * pricing and audience pages are read, not chatted with. The bubble stays on
 * docs, support, the auth flow and the rental browse, where a visitor has a
 * question in hand.
 */
const MARKETING_PATHS = ["/", "/pricing", "/why-proplane", "/partner", "/vendors", "/reviews", "/about", "/app", "/contact", "/security"];
export function isMarketingPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return MARKETING_PATHS.some((p) => (p === "/" ? pathname === "/" : pathname === p || pathname.startsWith(`${p}/`)));
}

/** Floating chat control for public pages — bottom-right, hidden when the portal assistant is active. */
export function GeneralAssistantFab() {
  const open = useGeneralOpen();
  const pathname = usePathname();
  const portalPresent = useSyncExternalStore(
    subscribePortalAssistantPresence,
    getPortalAssistantPresent,
    () => false,
  );
  const { isNative } = useIsNativeApp();

  if (open || portalPresent || isNative || isMarketingPath(pathname)) return null;

  function toggleAssistant() {
    if (open) {
      closeGeneralAssistant();
      return;
    }
    openAssistant();
  }

  return (
    <button
      type="button"
      onClick={toggleAssistant}
      data-attr="general-assistant-fab"
      aria-label="Ask PropLane"
      aria-expanded={open}
      className="fixed bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-[max(1.25rem,env(safe-area-inset-right))] z-[60] flex h-14 w-14 items-center justify-center rounded-full border border-primary/20 bg-[var(--btn-primary)] text-white shadow-[0_12px_40px_-12px_rgba(47,107,255,0.75)] outline-none transition hover:brightness-105 focus-visible:ring-2 focus-visible:ring-primary/40 active:scale-[0.97] lg:bottom-6 lg:right-6"
    >
      <ChatBubbleIcon className="h-6 w-6" />
    </button>
  );
}

/** Site-wide general AI assistant panel for public pages. */
export function GeneralAssistant() {
  const isClient = useIsClient();
  const open = useGeneralOpen();

  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<PendingChatAttachment[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const hasConversation = messages.length > 0;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => inputRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeGeneralAssistant();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const send = useCallback(
    async (prompt?: string) => {
      const text = userMessageContentFromInput(prompt ?? input, attachments);
      if (!text || loading) return;
      setError(null);
      const next: ChatMessage[] = [...messages, { role: "user", content: text }];
      setMessages(next);
      setInput("");
      const sentAttachments = attachments;
      setAttachments([]);
      const attachmentPayload = attachmentsToApiPayload(sentAttachments);
      setLoading(true);
      try {
        const res = await fetch("/api/agent/general-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: next, ...attachmentPayload }),
        });
        const data = (await res.json()) as { reply?: string; error?: string };
        if (!res.ok || data.error) {
          setError(data.error ?? "Something went wrong.");
          setAttachments(sentAttachments);
        } else {
          setMessages((m) => [...m, { role: "assistant", content: data.reply ?? "" }]);
        }
      } catch {
        setError("Network error.");
        setAttachments(sentAttachments);
      } finally {
        setLoading(false);
      }
    },
    [input, loading, messages, attachments],
  );

  function resetConversation() {
    attachments.forEach(revokeAttachmentPreview);
    setMessages([]);
    setError(null);
    setInput("");
    setAttachments([]);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  const panel = open ? (
    <div className="fixed inset-0 z-[70]">
      <button
        type="button"
        aria-label="Close PropLane AI assistant"
        className="fixed inset-0 bg-foreground/10 backdrop-blur-[2px]"
        onClick={closeGeneralAssistant}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="general-assistant-title"
        className="glass-card fixed bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-[max(1.25rem,env(safe-area-inset-right))] z-[71] flex h-[min(40rem,calc(100dvh-3rem))] w-[min(28rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-3xl border border-primary/15 shadow-[0_28px_70px_-28px_rgba(15,23,42,0.5)] backdrop-blur-xl lg:bottom-6 lg:right-6"
      >
        {/* Header */}
        <div className="relative shrink-0 overflow-hidden border-b border-border/70 px-4 py-3.5">
          <div
            className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--primary)_12%,transparent),transparent_55%)]"
            aria-hidden
          />
          <div className="relative flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                <ChatBubbleIcon className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p id="general-assistant-title" className="truncate text-sm font-semibold tracking-[-0.01em] text-foreground">
                  PropLane AI
                </p>
                <p className="truncate text-xs text-muted">Ask anything about PropLane</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {hasConversation && (
                <button
                  type="button"
                  onClick={resetConversation}
                  aria-label="Start a new conversation"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-muted outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/25"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
                    <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                onClick={closeGeneralAssistant}
                aria-label="Close PropLane AI assistant"
                className="flex h-8 w-8 items-center justify-center rounded-full text-muted outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/25"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Body */}
        <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
          {!hasConversation ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
              <div className="flex flex-col gap-1">
                <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground">
                  How can I help?
                </h3>
                <p className="max-w-[20rem] text-sm leading-relaxed text-muted">
                  Ask about PropLane: features, pricing, the live demo, or how to get started.
                </p>
              </div>
              <div className="grid w-full grid-cols-2 gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => void send(s.prompt)}
                    disabled={loading}
                    data-attr="general-assistant-suggestion"
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-border bg-foreground/[0.04] px-3 text-xs font-medium text-foreground outline-none transition-[border-color,background-color,transform] hover:border-primary/25 hover:bg-foreground/[0.07] focus-visible:ring-2 focus-visible:ring-primary/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              {messages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
                  <span
                    className={
                      "inline-block max-w-[88%] rounded-2xl px-3.5 py-2.5 text-left " +
                      (m.role === "user"
                        ? "whitespace-pre-wrap rounded-br-md text-white shadow-[0_8px_20px_-12px_rgba(47,107,255,0.6)]"
                        : "rounded-bl-md border border-border bg-foreground/[0.04] text-foreground")
                    }
                    style={m.role === "user" ? { background: "var(--btn-primary)" } : undefined}
                  >
                    {m.role === "user" ? m.content : <AssistantMarkdown text={m.content} />}
                  </span>
                </div>
              ))}
              {loading && (
                <div className="flex w-fit items-center gap-2 rounded-2xl border border-border/70 bg-foreground/[0.03] px-3 py-2 text-muted">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/70 [animation-delay:-0.2s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/70 [animation-delay:-0.1s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/70" />
                  <span className="text-xs">Thinking…</span>
                </div>
              )}
              {error && <p className="rounded-xl border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>}
            </div>
          )}
        </div>

        {/* Composer */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="shrink-0 border-t border-border/60 bg-background/60 px-3 pb-3 pt-3 backdrop-blur-sm"
        >
          <AssistantChatComposer
            input={input}
            setInput={setInput}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            onAttachmentError={(message) => setError(message)}
            loading={loading}
            inputRef={inputRef}
            placeholder="Ask about PropLane…"
            onSend={() => void send()}
          />
        </form>
      </div>
    </div>
  ) : null;

  return isClient ? createPortal(
    <>
      <GeneralAssistantFab />
      {panel}
    </>,
    document.body,
  ) : null;
}
