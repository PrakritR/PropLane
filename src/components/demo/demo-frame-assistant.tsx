"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MessageCircle } from "lucide-react";

import { AssistantChatComposer } from "@/components/portal/assistant-chat-composer";
import { AssistantMarkdown } from "@/components/portal/assistant-markdown";
import {
  attachmentsToApiPayload,
  revokeAttachmentPreview,
  userMessageContentFromInput,
  type PendingChatAttachment,
} from "@/lib/assistant-chat-attachments.client";
import type { ActionPreview } from "@/lib/tools/registry";
import {
  closeAxisAssistant,
  getAxisAssistantOpen,
  subscribeAxisAssistantOpen,
  subscribeAxisAssistantPrompt,
} from "@/lib/axis-assistant/open-store";
import { cn } from "@/lib/utils";

type ChatMessage = { role: "user" | "assistant"; content: string };
type ToolTraceEntry = { tool: string; ok: boolean };
type Suggestion = { label: string; prompt: string };
type PendingAction = {
  id: string;
  toolName: string;
  preview: ActionPreview;
  simulated?: boolean;
};

// Portal/property-scoped starters — the same kind of questions the real portal
// Axis Assistant answers, grounded in the sandboxed demo portfolio.
const SUGGESTIONS: Suggestion[] = [
  { label: "Late on rent", prompt: "Who is late on rent right now?" },
  { label: "Leases to sign", prompt: "How many leases are awaiting signature?" },
  { label: "Overdue balance", prompt: "What's the total overdue balance across the portfolio?" },
];

function ChatIcon({ className }: { className?: string }) {
  return <MessageCircle className={className} aria-hidden="true" />;
}

function useOpen() {
  return useSyncExternalStore(subscribeAxisAssistantOpen, getAxisAssistantOpen, () => false);
}

/**
 * The in-demo Axis Assistant — the portal/property-scoped panel for scripted
 * demo prompts. It is fully contained within the demo frame when opened.
 *
 * The "Run demo" auto-play drives this via the shared scripted-prompt channel.
 */
export function DemoFrameAssistant() {
  const open = useOpen();
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<PendingChatAttachment[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [lastTools, setLastTools] = useState<ToolTraceEntry[]>([]);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
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
      setLastTools([]);
      setPendingAction(null);
      try {
        const res = await fetch("/api/agent/demo-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: next, ...attachmentPayload }),
        });
        const data = (await res.json()) as {
          reply?: string;
          toolTrace?: ToolTraceEntry[];
          pendingAction?: PendingAction;
          error?: string;
        };
        if (!res.ok || data.error) {
          setError(data.error ?? "Something went wrong.");
          setAttachments(sentAttachments);
        } else {
          if (data.reply || !data.pendingAction) {
            setMessages((m) => [...m, { role: "assistant", content: data.reply ?? "" }]);
          }
          setLastTools(data.toolTrace ?? []);
          setPendingAction(data.pendingAction ?? null);
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

  const resolvePendingAction = useCallback(
    async (decision: "confirm" | "cancel") => {
      if (!pendingAction || loading) return;
      if (decision === "cancel") {
        setPendingAction(null);
        return;
      }
      setLoading(true);
      try {
        const res = await fetch("/api/agent/demo-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actionId: pendingAction.id, decision }),
        });
        const data = (await res.json()) as { reply?: string; error?: string };
        if (!res.ok || data.error) {
          setError(data.error ?? "Something went wrong.");
        } else {
          setMessages((m) => [...m, { role: "assistant", content: data.reply ?? "Done." }]);
          setPendingAction(null);
        }
      } catch {
        setError("Network error.");
      } finally {
        setLoading(false);
      }
    },
    [pendingAction, loading],
  );

  // Scripted prompts from the "Run demo" auto-play arrive on the shared channel.
  const sendRef = useRef<(prompt?: string) => void>(() => {});
  useEffect(() => {
    sendRef.current = (prompt?: string) => void send(prompt);
  });
  useEffect(() => {
    return subscribeAxisAssistantPrompt((prompt) => {
      requestAnimationFrame(() => sendRef.current(prompt));
    });
  }, []);

  function resetConversation() {
    attachments.forEach(revokeAttachmentPreview);
    setMessages([]);
    setLastTools([]);
    setPendingAction(null);
    setError(null);
    setInput("");
    setAttachments([]);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  return (
    <>
      {/* Panel — contained within the frame */}
      {open ? (
        <div className="absolute inset-0 z-50">
          <button
            type="button"
            aria-label="Close PropLane Assistant"
            className="absolute inset-0 bg-foreground/10 backdrop-blur-[1px]"
            onClick={closeAxisAssistant}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="demo-assistant-title"
            className="glass-card absolute bottom-4 right-4 z-[51] flex h-[min(30rem,calc(100%-2rem))] w-[min(22rem,calc(100%-2rem))] flex-col overflow-hidden rounded-2xl border border-primary/15 shadow-[0_24px_60px_-24px_rgba(15,23,42,0.5)] backdrop-blur-xl"
          >
            <div className="relative shrink-0 overflow-hidden border-b border-border/70 px-4 py-3">
              <div
                className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--primary)_10%,transparent),transparent_55%)]"
                aria-hidden
              />
              <div className="relative flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                    <ChatIcon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p id="demo-assistant-title" className="truncate text-sm font-semibold tracking-[-0.01em] text-foreground">
                      PropLane Assistant
                    </p>
                    <p className="truncate text-xs text-muted">Grounded in this portfolio</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {hasConversation && (
                    <button
                      type="button"
                      onClick={resetConversation}
                      aria-label="Start a new conversation"
                      className="flex h-7 w-7 items-center justify-center rounded-full text-muted outline-none transition-colors hover:bg-foreground/5 hover:text-foreground"
                    >
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
                        <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={closeAxisAssistant}
                    aria-label="Close PropLane Assistant"
                    className="flex h-7 w-7 items-center justify-center rounded-full text-muted outline-none transition-colors hover:bg-foreground/5 hover:text-foreground"
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
                      <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3.5">
              {!hasConversation ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
                  <div className="flex flex-col gap-1">
                    <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
                      What should we look at first?
                    </h3>
                    <p className="max-w-[16rem] text-xs leading-relaxed text-muted">
                      Rent, leases, reminders, grounded in this demo portfolio.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s.label}
                        type="button"
                        onClick={() => void send(s.prompt)}
                        disabled={loading}
                        data-attr="demo-assistant-suggestion"
                        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full border border-border bg-foreground/[0.04] px-3 text-xs font-medium text-foreground outline-none transition-[border-color,background-color,transform] hover:border-primary/25 hover:bg-foreground/[0.07] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-2.5 text-sm">
                  {messages.map((m, i) => (
                    <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
                      <span
                        className={cn(
                          "inline-block max-w-[88%] rounded-2xl px-3 py-2 text-left",
                          m.role === "user"
                            ? "whitespace-pre-wrap rounded-br-md text-white shadow-[0_8px_20px_-12px_rgba(47,95,208,0.6)]"
                            : "rounded-bl-md border border-border bg-foreground/[0.04] text-foreground",
                        )}
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
                  {error && <p className="rounded-xl border border-danger/20 bg-danger/5 px-3 py-2 text-xs text-danger">{error}</p>}
                  {lastTools.length > 0 && (
                    <p className="text-xs text-muted">Used: {lastTools.map((t) => t.tool).join(", ")}</p>
                  )}
                </div>
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
              className="shrink-0 border-t border-border/60 bg-background/60 px-3 pb-3 pt-3 backdrop-blur-sm"
            >
              {pendingAction ? (
                <div className="mb-3 rounded-2xl border border-primary/25 bg-primary/5 p-3">
                  <p className="text-xs font-semibold text-foreground">{pendingAction.preview.title}</p>
                  {pendingAction.preview.summary ? (
                    <p className="mt-1 text-xs leading-relaxed text-muted">{pendingAction.preview.summary}</p>
                  ) : null}
                  {(pendingAction.preview.fields ?? []).slice(0, 4).map((field, i) => (
                    <div key={i} className="mt-1 flex items-baseline justify-between gap-3 text-xs">
                      <span className="shrink-0 font-medium text-foreground">{field.label}</span>
                      <span className="truncate text-right text-muted">{field.value}</span>
                    </div>
                  ))}
                  <p className="mt-2 text-[11px] italic text-muted">Demo — nothing will actually be sent.</p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => void resolvePendingAction("confirm")}
                      data-attr="demo-assistant-action-confirm"
                      className="flex-1 rounded-full bg-primary px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      {pendingAction.preview.confirmLabel ?? "Confirm"}
                    </button>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => void resolvePendingAction("cancel")}
                      data-attr="demo-assistant-action-cancel"
                      className="rounded-full border border-border px-3 py-2 text-xs font-semibold text-muted"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              <AssistantChatComposer
                input={input}
                setInput={setInput}
                attachments={attachments}
                onAttachmentsChange={setAttachments}
                onAttachmentError={(message) => setError(message)}
                loading={loading}
                compact
                inputRef={inputRef}
                placeholder="Ask about this portfolio…"
                onSend={() => void send()}
              />
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
