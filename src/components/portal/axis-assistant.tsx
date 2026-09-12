"use client";

import {
  createContext,
  memo,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";

import { track } from "@/lib/analytics/track-client";
import { ModalShell } from "@/components/ui/modal";
import { AssistantChatComposer } from "@/components/portal/assistant-chat-composer";
import { AssistantChatHistoryPanel } from "@/components/portal/assistant-chat-history-panel";
import {
  AssistantEmptyState,
  AssistantMessageList,
  AssistantPanelHeader,
  MANAGER_ASSISTANT_ENDPOINT,
} from "@/components/portal/assistant-panel-chrome";
import { AssistantPendingActionCard, AxisAssistantSparkleIcon } from "@/components/portal/assistant-shared";
import {
  AssistantConversationProvider,
  useOptionalAssistantConversation,
} from "@/lib/axis-assistant/assistant-conversation-context";
import { visibleConversationMessages } from "@/lib/axis-assistant/use-assistant-conversation";
import { useAssistantDisplayMode } from "@/hooks/use-assistant-display-mode";
import { useIsClient } from "@/hooks/use-is-client";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { useNativeChrome } from "@/hooks/use-is-native-app";
import { useVisualViewportBottomInset } from "@/hooks/use-visual-viewport-bottom-inset";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  DEFAULT_ASSISTANT_DISPLAY_MODE,
  readAssistantDisplayMode,
  setAssistantDisplayMode,
  type AssistantDisplayMode,
} from "@/lib/assistant-display-preferences";
import { getAssistantDocked, setAssistantDocked, expandAssistantDock } from "@/lib/axis-assistant/dock-store";
import {
  closeAxisAssistant,
  getAxisAssistantOpen,
  openAxisAssistant,
  setAxisAssistantOpen,
  subscribeAxisAssistantOpen,
  subscribeAxisAssistantPrompt,
} from "@/lib/axis-assistant/open-store";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";
import { registerPortalAssistant } from "@/lib/general-assistant/open-store";
import { cn } from "@/lib/utils";
import {
  shouldHideAssistantFab,
  subscribeAssistantFabVisibility,
} from "@/lib/axis-assistant/fab-visibility";

const AxisAssistantPresenceContext = createContext(false);

/** True when the layout wraps children in {@link AxisAssistant}. */
export function useHasAxisAssistant() {
  return useContext(AxisAssistantPresenceContext);
}

export type AxisAssistantDockState = {
  /**
   * True only where a full-height right rail can actually be shown: a portal
   * that opted in via `dockable`, with a live signed-in session, outside the
   * /demo sandbox. False everywhere else, which makes every dock affordance
   * (the pin button, the rail, the Settings toggle) disappear rather than
   * writing a preference nothing honors.
   */
  dockable: boolean;
  mode: AssistantDisplayMode;
  setMode: (mode: AssistantDisplayMode) => void;
};

const AxisAssistantDockContext = createContext<AxisAssistantDockState>({
  dockable: false,
  mode: "popup",
  setMode: () => {},
});

/**
 * The manager's assistant display preference plus whether this portal can honor
 * it. Consumed by the popup's pin control, the right-rail dock, and the Settings
 * toggle so all three write the SAME persisted preference.
 */
export function useAxisAssistantDock(): AxisAssistantDockState {
  return useContext(AxisAssistantDockContext);
}

function useAxisAssistantOpen() {
  return useSyncExternalStore(subscribeAxisAssistantOpen, getAxisAssistantOpen, () => false);
}

function handleOpenAssistant() {
  track("assistant_opened");
  startTransition(() => {
    openAxisAssistant();
  });
}

/**
 * Assistant FAB — floats above the bottom nav bar in the native app (clearing it
 * via the same measured `--portal-native-bottom-nav-inset` the bar itself uses),
 * bottom-right on web. Always rendered: the assistant is no longer a bar slot.
 *
 * In docked mode the rail already puts the assistant on screen at `lg`+, so the
 * FAB hides there (`lg:hidden`) and stays the assistant below `lg`, where the
 * rail never renders.
 */
function AxisAssistantFixedTrigger({ docked }: { docked: boolean }) {
  const open = useAxisAssistantOpen();
  const hideFab = useSyncExternalStore(subscribeAssistantFabVisibility, shouldHideAssistantFab, () => false);
  if (open || hideFab) return null;

  return (
    <button
      type="button"
      onClick={handleOpenAssistant}
      aria-label="Open PropLane Assistant"
      aria-expanded={open}
      data-attr="axis-assistant-fab"
      className={cn(
        "axis-assistant-fab group fixed bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-[max(1.25rem,env(safe-area-inset-right))] z-[55] flex h-12 w-12 items-center justify-center rounded-full text-white shadow-[0_12px_28px_-12px_rgba(47,107,255,0.75)] outline-none transition-[transform,filter] duration-200 hover:scale-105 hover:brightness-110 focus-visible:ring-2 focus-visible:ring-primary/30 active:scale-95 lg:bottom-6 lg:right-6 max-lg:bottom-[calc(var(--portal-native-bottom-nav-inset)+0.75rem)] max-lg:h-11 max-lg:w-11 [html[data-native]_&]:bottom-[calc(var(--portal-native-bottom-nav-inset)+0.75rem)] [html[data-native]_&]:h-11 [html[data-native]_&]:w-11",
        docked && "lg:hidden",
      )}
      style={{ background: "var(--btn-primary)" }}
    >
      <AxisAssistantSparkleIcon className="h-5 w-5 max-lg:h-[18px] max-lg:w-[18px] [html[data-native]_&]:h-[18px] [html[data-native]_&]:w-[18px]" />
    </button>
  );
}

const MemoizedLayoutSlot = memo(function MemoizedLayoutSlot({ children }: { children: ReactNode }) {
  return children;
});

/**
 * The panel lives outside the portal layout tree so opening the assistant does not
 * re-render dashboard/sidebar content (keeps INP under budget).
 */
function AxisAssistantChrome({ managerName, endpoint = MANAGER_ASSISTANT_ENDPOINT }: { managerName?: string | null; endpoint?: string }) {
  const isClient = useIsClient();
  const { dockable, mode, setMode } = useAxisAssistantDock();
  const showNativeChrome = useNativeChrome();
  const open = useAxisAssistantOpen();
  const hideFab = useSyncExternalStore(subscribeAssistantFabVisibility, shouldHideAssistantFab, () => false);
  const [panelReady, setPanelReady] = useState(false);
  // This is the same provider consumed by the dock rail, so switching layouts
  // cannot fork the conversation or strand a pending confirmation.
  const {
    input,
    setInput,
    attachments,
    setAttachments,
    messages,
    ratings,
    submitFeedback,
    pendingAction,
    loading,
    error,
    setError,
    send,
    resolvePendingAction,
    reset,
    threads,
    activeThreadId,
    historyOpen,
    historyLoading,
    historyError,
    historySearch,
    hasMoreHistory,
    multiThread,
    openHistory,
    closeHistory,
    searchHistory,
    selectThread,
    deleteThread,
    loadMoreHistory,
    hydrateArchive,
    startNewChat,
  } = useOptionalAssistantConversation(endpoint);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [historyPortal, setHistoryPortal] = useState<HTMLElement | null>(null);
  const keyboardInset = useVisualViewportBottomInset(open && panelReady);

  const firstName = managerName?.trim().split(/\s+/)[0] || null;
  const visibleMessages = visibleConversationMessages(messages);
  const hasConversation = visibleMessages.length > 0 || Boolean(pendingAction);
  const keyboardOpen = keyboardInset > 0;

  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset panel readiness when closed
      setPanelReady(false);
      return;
    }
    const frame = requestAnimationFrame(() => {
      setPanelReady(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (hideFab && open) closeAxisAssistant();
  }, [hideFab, open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  useEffect(() => {
    if (!open || !panelReady || showNativeChrome) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, panelReady, showNativeChrome]);

  useEffect(() => {
    if (open) void hydrateArchive();
  }, [hydrateArchive, open]);

  useEffect(() => {
    if (!open) {
      document.documentElement.removeAttribute("data-axis-assistant-open");
      return;
    }
    document.documentElement.setAttribute("data-axis-assistant-open", "");
    return () => document.documentElement.removeAttribute("data-axis-assistant-open");
  }, [open]);

  const closePanel = useCallback(() => {
    closeAxisAssistant();
  }, []);

  // Presentation only: switching modes writes the preference and closes the
  // popup so the rail takes over. It never touches the conversation transport.
  const pinToRail = useCallback(() => {
    setMode("docked");
    closeAxisAssistant();
  }, [setMode]);

  // Scripted prompts (the /demo "Run demo" auto-play) submit through here.
  const sendRef = useRef<(prompt?: string) => void>(() => {});
  useEffect(() => {
    return subscribeAxisAssistantPrompt((prompt) => {
      // Defer so the panel is mounted/open before the first scripted send.
      requestAnimationFrame(() => sendRef.current(prompt));
    });
  }, []);

  function resetConversation() {
    reset();
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // Keep the scripted-prompt sender pointing at the latest closure (updated
  // after each render so it captures current messages/loading state).
  useEffect(() => {
    sendRef.current = (prompt?: string) => void send(prompt);
  });

  const hideEmptyChrome = showNativeChrome && keyboardOpen && !hasConversation;

  const panelStyle: CSSProperties | undefined = showNativeChrome
    ? keyboardOpen
      ? {
          bottom: `${keyboardInset + 8}px`,
          maxHeight: `calc(100dvh - var(--native-safe-top, 0px) - ${keyboardInset}px - 0.75rem)`,
        }
      : undefined
    : keyboardOpen
      ? {
          transform: `translateY(-${keyboardInset}px)`,
          maxHeight: `calc(100dvh - var(--native-safe-top, 0px) - var(--native-safe-bottom, 0px) - 5rem - ${keyboardInset}px)`,
        }
      : undefined;

  const assistantPanelClassName = cn(
    "axis-assistant-panel glass-card fixed z-[66] flex h-[min(38rem,calc(100dvh-7.5rem))] flex-col overflow-hidden border border-primary/15 shadow-[0_24px_60px_-24px_rgba(15,23,42,0.45),0_0_0_1px_rgba(47,107,255,0.08)] backdrop-blur-xl outline-none",
    keyboardOpen && "axis-assistant-panel--keyboard",
  );

  return (
    <>
      <AxisAssistantFixedTrigger docked={dockable && mode === "docked"} />
      {isClient && open ? (
        <ModalShell
          open={open}
          onClose={closePanel}
          presentation="dialog"
          stackClassName="axis-assistant-root fixed inset-0 z-[65]"
          overlayClassName="axis-assistant-backdrop fixed inset-0"
          centerClassName="contents"
          contentRef={setHistoryPortal}
          panelStyle={panelReady ? panelStyle : undefined}
          panelClassName={assistantPanelClassName}
          ariaLabelledBy={panelReady ? "axis-assistant-title" : undefined}
          ariaLabel={panelReady ? undefined : "Opening PropLane Assistant"}
          ariaBusy={panelReady ? undefined : true}
        >
          {panelReady ? (
            <>
          <AssistantPanelHeader
            titleId="axis-assistant-title"
            onClose={closePanel}
            onPinToRail={dockable ? pinToRail : undefined}
            showHistory={multiThread}
            onOpenHistory={openHistory}
            showNew={multiThread || hasConversation}
            onNew={() => {
              if (multiThread) {
                void startNewChat().then(() => requestAnimationFrame(() => inputRef.current?.focus()));
              } else {
                resetConversation();
              }
            }}
            className="[html[data-native]_&]:py-1.5"
          />

          {multiThread ? (
            <AssistantChatHistoryPanel
              open={historyOpen}
              threads={threads}
              activeThreadId={activeThreadId}
              onSelect={selectThread}
              onDelete={deleteThread}
              onNewChat={() => {
                void startNewChat().then(() => requestAnimationFrame(() => inputRef.current?.focus()));
              }}
              onClose={closeHistory}
              loading={historyLoading}
              error={historyError}
              searchQuery={historySearch}
              hasMore={hasMoreHistory}
              onRetry={openHistory}
              onLoadMore={loadMoreHistory}
              onSearchQueryChange={searchHistory}
              portalContainer={historyPortal}
            />
          ) : null}

          {hideEmptyChrome ? null : (
            <div
              ref={scrollRef}
              className={cn(
                "flex flex-col overflow-y-auto px-3 py-3 [html[data-native]_&]:py-2",
                hasConversation ? "min-h-0 flex-1" : "min-h-0 flex-1 [html[data-native]_&]:flex-none",
              )}
            >
              {!hasConversation ? (
                <AssistantEmptyState
                  firstName={firstName}
                  showQueue={endpoint === MANAGER_ASSISTANT_ENDPOINT}
                  onNavigate={closePanel}
                  onPick={(prompt) => void send(prompt)}
                  disabled={loading}
                  hideChips={keyboardOpen}
                  className="[html[data-native]_&]:flex-none"
                />
              ) : (
                <AssistantMessageList
                  messages={visibleMessages}
                  ratings={ratings}
                  onRate={submitFeedback}
                  loading={loading}
                  trailing={
                    error ? (
                      <p className="rounded-xl border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>
                    ) : null
                  }
                />
              )}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            className="shrink-0 border-t border-border/60 bg-background/60 px-3 pb-3 pt-3 backdrop-blur-sm [html[data-native]_&]:pb-[max(0.75rem,var(--native-safe-bottom))]"
          >
            {pendingAction ? (
              <AssistantPendingActionCard
                pendingAction={pendingAction}
                loading={loading}
                onResolve={(decision) => void resolvePendingAction(decision)}
              />
            ) : null}
            <AssistantChatComposer
              input={input}
              setInput={setInput}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              onAttachmentError={(message) => setError(message)}
              loading={loading}
              inputRef={inputRef}
              placeholder="Ask about your portfolio…"
              onSend={() => void send()}
            />
          </form>
            </>
          ) : null}
        </ModalShell>
      ) : null}
    </>
  );
}

/**
 * Axis Assistant panel. Grounded Q&A plus gated actions: it sends the
 * conversation to the agent endpoint, renders answers and which tools ran,
 * and shows a confirmation card for any write action the agent proposes.
 */
export function AxisAssistant({
  managerName,
  endpoint,
  dockable = false,
  children,
}: {
  managerName?: string | null;
  /** Chat backend to target. Defaults to the auth-gated manager
   * `/api/agent/chat`. Each portal MUST pass its own role-scoped endpoint —
   * `/api/agent/resident-chat`, `/api/agent/vendor-chat` — because the manager
   * context resolver rejects non-managers; the public demo passes the sandboxed
   * `/api/agent/demo-chat`. */
  endpoint?: string;
  /**
   * Opt this portal into the docked presentation: it must render
   * `<PortalAssistantDockRail />` somewhere the rail can occupy the full-height
   * right edge. Off by default, so every other portal — and the /demo sandbox,
   * which drives its own scripted assistant — keeps the popup and never shows a
   * pin control that leads nowhere.
   */
  dockable?: boolean;
  children: ReactNode;
}) {
  const { userId, ready: authReady } = useManagerUserId();
  const { mode, setMode } = useAssistantDisplayMode(userId);

  // One-time migration from the legacy cookie-backed dock flag to localStorage.
  useEffect(() => {
    if (!userId || !dockable || !authReady || isDemoModeActive()) return;
    if (readAssistantDisplayMode(userId) !== DEFAULT_ASSISTANT_DISPLAY_MODE) return;
    if (!getAssistantDocked()) return;
    setAssistantDisplayMode(userId, "docked");
    setAssistantDocked(false);
    expandAssistantDock();
  }, [authReady, dockable, userId]);

  useEffect(() => {
    return () => setAxisAssistantOpen(false);
  }, []);

  // Announce to the site-wide general assistant that a portal-scoped assistant
  // FAB is on screen, so it lifts its own FAB above ours (both are bottom-right).
  useEffect(() => registerPortalAssistant(), []);

  // The dock is a live, auth-gated surface: it is only offered once the session
  // is known and never inside /demo (which must not reach `/api/agent/chat`).
  const dockEnabled = dockable && authReady && !!userId && !isDemoModeActive();
  const dockState = useMemo<AxisAssistantDockState>(
    () => ({ dockable: dockEnabled, mode, setMode }),
    [dockEnabled, mode, setMode],
  );

  const chatEndpoint = endpoint ?? "/api/agent/chat";

  return (
    <PortalAssistantConfigProvider endpoint={chatEndpoint} managerName={managerName ?? null}>
      <AxisAssistantPresenceContext.Provider value={true}>
        <AxisAssistantDockContext.Provider value={dockState}>
          <AssistantConversationProvider endpoint={chatEndpoint}>
            <MemoizedLayoutSlot>{children}</MemoizedLayoutSlot>
            <AxisAssistantChrome managerName={managerName} endpoint={chatEndpoint} />
          </AssistantConversationProvider>
        </AxisAssistantDockContext.Provider>
      </AxisAssistantPresenceContext.Provider>
    </PortalAssistantConfigProvider>
  );
}
