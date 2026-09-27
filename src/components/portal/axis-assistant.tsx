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
import { AssistantSmsTestControl } from "@/components/portal/assistant-sms-test-control";
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
import { propertyCatalogScopeKey, subscribePropertyCatalogScope } from "@/lib/demo-property-pipeline";
import { useActiveWorkspaceIdentity } from "@/hooks/use-selected-workspace-id";
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
import { PortalAssistantConfigProvider, usePortalAssistantConfig } from "@/lib/axis-assistant/portal-assistant-context";
import { registerPortalAssistant } from "@/lib/general-assistant/open-store";
import { cn } from "@/lib/utils";
import {
  shouldHideAssistantFab,
  subscribeAssistantFabVisibility,
} from "@/lib/axis-assistant/fab-visibility";

const AxisAssistantPresenceContext = createContext(false);

type SmsTestCapabilityPayload = {
  targets: Array<{
    listingId: string;
    managerUserId: string;
    title: string;
    address: string;
    stage?: "prospect" | "submitted" | "approved";
  }>;
};

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
 * Assistant FAB — phones and tablets only. It floats above the bottom nav bar
 * in the native app (clearing it via the same measured
 * `--portal-native-bottom-nav-inset` the bar itself uses).
 *
 * At `lg`+ the top bar's Ask PropLane (and ⌘K) is the one entry point, so the
 * FAB never renders there (`lg:hidden`); below `lg` that bar is hidden and the
 * FAB is the assistant.
 */
function AxisAssistantFixedTrigger() {
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
      // A ringed card-background circle, not a filled primary one (AXI night
      // sweep area 2e) — this used to be the identical filled blue circle as
      // the page's own primary "+" (`PortalPrimaryIconAction`), same size,
      // same corner, so the two were impossible to tell apart on phone. The
      // page's "+" stays the only solid-blue circle on screen; the assistant
      // reads as a secondary utility control that happens to float.
      className="axis-assistant-fab group fixed bottom-[calc(var(--portal-native-bottom-nav-inset)+0.75rem)] right-[max(1.25rem,env(safe-area-inset-right))] z-[55] flex h-11 w-11 items-center justify-center rounded-full border border-primary/25 bg-card text-primary shadow-[0_12px_28px_-16px_rgba(15,23,42,0.45)] outline-none transition-[transform,filter] duration-200 hover:scale-105 hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/30 active:scale-95 lg:hidden"
    >
      <AxisAssistantSparkleIcon className="h-[18px] w-[18px]" />
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
  const { dockable, setMode } = useAxisAssistantDock();
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
  const smsTestActive = usePortalAssistantConfig()?.smsTest?.active ?? false;

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
      <AxisAssistantFixedTrigger />
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

          <AssistantSmsTestControl />

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
              {!hasConversation && smsTestActive ? (
                <p className="m-auto max-w-sm rounded-xl border border-primary/15 bg-primary/5 px-3 py-2 text-center text-xs leading-relaxed text-muted">
                  Send the same short replies you would text. Type YES or NO when the SMS assistant asks for confirmation.
                </p>
              ) : !hasConversation ? (
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
              placeholder={smsTestActive ? "Type an SMS message…" : "Ask about your portfolio…"}
              allowAttachments={!smsTestActive}
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
  smsTestPortal,
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
  /** Opts an authenticated manager or resident portal into non-production SMS testing. */
  smsTestPortal?: "manager" | "resident";
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
  const workspace = useActiveWorkspaceIdentity();
  const catalogScopeKey = useSyncExternalStore(subscribePropertyCatalogScope, propertyCatalogScopeKey, () => "server");
  const capabilityScopeKey = JSON.stringify([catalogScopeKey, userId, workspace.id, authReady, smsTestPortal, chatEndpoint]);
  type SmsControlState = {
    scopeKey: string;
    capability: SmsTestCapabilityPayload | null;
    visible: boolean;
    loading: boolean;
    error: string | null;
    active: boolean;
    targetId: string;
  };
  const emptySmsState: SmsControlState = {
    scopeKey: capabilityScopeKey,
    capability: null,
    visible: false,
    loading: Boolean(smsTestPortal && authReady && userId),
    error: null,
    active: false,
    targetId: "",
  };
  const [storedSmsState, setSmsState] = useState<SmsControlState>(emptySmsState);
  // Mask the old target and active endpoint during render, before effect cleanup.
  const smsState = storedSmsState.scopeKey === capabilityScopeKey ? storedSmsState : emptySmsState;
  const [smsCapabilityAttempt, setSmsCapabilityAttempt] = useState(0);

  useEffect(() => {
    if (!smsTestPortal || !authReady || !userId || isDemoModeActive()) return;
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted
      && propertyCatalogScopeKey() === catalogScopeKey;
    const update = (patch: Partial<SmsControlState>) => {
      if (!isCurrent()) return;
      setSmsState((current) => {
        if (!isCurrent()) return current;
        const base: SmsControlState = current.scopeKey === capabilityScopeKey ? current : {
          scopeKey: capabilityScopeKey, capability: null, visible: false,
          loading: true, error: null, active: false, targetId: "",
        };
        return { ...base, ...patch };
      });
    };
    void fetch(`/api/agent/sms-test/capability?portal=${smsTestPortal}`, {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as {
          capability?: { targets?: SmsTestCapabilityPayload["targets"] } | null;
          error?: string;
        };
        if (!isCurrent()) return;
        // response.ok with a null capability is the ordinary "not eligible"
        // answer (most accounts are not a test-workspace member) — silent,
        // not an error. A 404 is kept as the same silent case for any older
        // cached client/service-worker response still using that shape.
        if (response.status === 404 || (response.ok && !data.capability)) {
          update({ capability: null, visible: false, active: false, targetId: "", error: null });
          return;
        }
        if (!response.ok || !data.capability) {
          update({ visible: true });
          throw new Error(data.error ?? "SMS test mode is unavailable.");
        }
        const targets = Array.isArray(data.capability.targets) ? data.capability.targets : [];
        update({ visible: true, error: null, capability: { targets }, active: false, targetId: "" });
      })
      .catch((error: unknown) => {
        update({ active: false, capability: null, targetId: "", visible: true,
          error: error instanceof Error ? error.message : "SMS test mode is unavailable." });
      })
      .finally(() => update({ loading: false }));
    return () => controller.abort();
  }, [authReady, userId, catalogScopeKey, capabilityScopeKey, smsCapabilityAttempt, smsTestPortal]);

  const smsTestEndpoint = smsTestPortal
    ? `/api/agent/sms-test?portal=${smsTestPortal}${smsState.targetId ? `&targetListingId=${encodeURIComponent(smsState.targetId)}` : ""}`
    : chatEndpoint;
  const activeEndpoint = smsState.active ? smsTestEndpoint : chatEndpoint;
  const updateCurrentSmsState = (patch: Partial<SmsControlState>) => {
    if (propertyCatalogScopeKey() !== catalogScopeKey) return;
    setSmsState((current) => current.scopeKey === capabilityScopeKey ? { ...current, ...patch } : current);
  };
  const smsTestConfig = smsTestPortal && smsState.visible
    ? {
        active: smsState.active,
        loading: smsState.loading,
        error: smsState.error,
        portal: smsTestPortal,
        targets: smsState.capability?.targets ?? [],
        selectedTargetId: smsState.targetId,
        onSelectTarget: (listingId: string) => updateCurrentSmsState({ targetId: listingId }),
        onToggle: () => {
          if (!smsState.loading && !smsState.error && smsState.capability) {
            updateCurrentSmsState({ active: !smsState.active });
          }
        },
        onRetry: () => {
          updateCurrentSmsState({ loading: true, error: null, active: false });
          setSmsCapabilityAttempt((attempt) => attempt + 1);
        },
      }
    : undefined;

  return (
    <PortalAssistantConfigProvider endpoint={activeEndpoint} managerName={managerName ?? null} smsTest={smsTestConfig}>
      <AxisAssistantPresenceContext.Provider value={true}>
        <AxisAssistantDockContext.Provider value={dockState}>
          <AssistantConversationProvider
            endpoint={activeEndpoint}
            archiveKey={`${userId ?? "anonymous"}:${workspace.id ?? ""}`}
          >
            <MemoizedLayoutSlot>{children}</MemoizedLayoutSlot>
            <AxisAssistantChrome managerName={managerName} endpoint={activeEndpoint} />
          </AssistantConversationProvider>
        </AxisAssistantDockContext.Provider>
      </AxisAssistantPresenceContext.Provider>
    </PortalAssistantConfigProvider>
  );
}
