"use client";

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { ModalShell } from "@/components/ui/modal";
import { AssistantDockPanel } from "@/components/portal/assistant-dock-panel";
import { ASSISTANT_DOCK_INPUT_ID } from "@/components/portal/assistant-dock-input-id";
import { MANAGER_ASSISTANT_ENDPOINT } from "@/components/portal/assistant-panel-chrome";
import {
  AssistantConversationProvider,
  useOptionalAssistantConversation,
} from "@/lib/axis-assistant/assistant-conversation-context";
import { propertyCatalogScopeKey, subscribePropertyCatalogScope } from "@/lib/demo-property-pipeline";
import { useActiveWorkspaceIdentity } from "@/hooks/use-selected-workspace-id";
import { useIsClient } from "@/hooks/use-is-client";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { useIsSmallPortalViewport } from "@/hooks/use-is-native-app";
import { useVisualViewportBottomInset } from "@/hooks/use-visual-viewport-bottom-inset";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  closeAxisAssistant,
  getAxisAssistantOpen,
  setAxisAssistantOpen,
  subscribeAxisAssistantOpen,
  subscribeAxisAssistantPrompt,
} from "@/lib/axis-assistant/open-store";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";

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

function useAxisAssistantOpen() {
  return useSyncExternalStore(subscribeAxisAssistantOpen, getAxisAssistantOpen, () => false);
}

const MemoizedLayoutSlot = memo(function MemoizedLayoutSlot({ children }: { children: ReactNode }) {
  return children;
});

/**
 * The phone assistant: a full-screen sheet opened from the top bar's sparkle
 * button, closed back to the page. It is NOT floating - desktop has no window
 * of its own (the side panel is the assistant there, mounted by the layout's
 * `<PortalAssistantRail>`). This component also owns the scripted-prompt
 * channel, because it is mounted on every viewport inside the same
 * conversation provider the side panel reads.
 */
function AxisAssistantChrome({ managerName, endpoint = MANAGER_ASSISTANT_ENDPOINT }: { managerName?: string | null; endpoint?: string }) {
  const isClient = useIsClient();
  const isSmall = useIsSmallPortalViewport();
  const open = useAxisAssistantOpen();
  const sheetOpen = open && isSmall;
  const keyboardInset = useVisualViewportBottomInset(sheetOpen);
  const { send } = useOptionalAssistantConversation(endpoint);

  // The sheet only exists below `lg`; a resize up to desktop drops it (the
  // side panel is the desktop surface).
  useEffect(() => {
    if (open && !isSmall && !isDemoModeActive()) closeAxisAssistant();
  }, [isSmall, open]);

  useEffect(() => {
    if (!sheetOpen) {
      document.documentElement.removeAttribute("data-axis-assistant-open");
      return;
    }
    document.documentElement.setAttribute("data-axis-assistant-open", "");
    return () => document.documentElement.removeAttribute("data-axis-assistant-open");
  }, [sheetOpen]);

  const closeSheet = useCallback(() => {
    closeAxisAssistant();
  }, []);

  // Scripted and launcher prompts submit through here, into the shared
  // conversation, so the side panel and the sheet both show the answer.
  const sendRef = useRef<(prompt?: string) => void>(() => {});
  useEffect(() => {
    return subscribeAxisAssistantPrompt((prompt) => {
      // Defer so the surface is mounted/open before the first send.
      requestAnimationFrame(() => sendRef.current(prompt));
    });
  }, []);
  useEffect(() => {
    sendRef.current = (prompt?: string) => void send(prompt);
  });

  if (!isClient || !sheetOpen) return null;

  return (
    <ModalShell
      open
      onClose={closeSheet}
      presentation="dialog"
      hideOverlay
      stackClassName="axis-assistant-root fixed inset-0 z-[65]"
      centerClassName="contents"
      panelClassName="axis-assistant-sheet fixed inset-x-0 top-0 z-[66] flex flex-col overflow-hidden bg-card outline-none"
      panelStyle={{ bottom: keyboardInset > 0 ? `${keyboardInset}px` : 0 }}
      ariaLabel="PropLane Assistant"
    >
      <AssistantDockPanel
        managerName={managerName}
        endpoint={endpoint}
        onClose={closeSheet}
        inputId={ASSISTANT_DOCK_INPUT_ID}
        className="h-full rounded-none border-0 bg-transparent pt-[var(--native-safe-top,0px)] pb-[var(--native-safe-bottom,0px)]"
      />
    </ModalShell>
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
  disabled = false,
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
   * Mount nothing: no sheet, no capability lookup. A "View as"
   * support session sets this, because the assistant acts as the signed-in
   * account and every agent route is a write the session may not make.
   */
  disabled?: boolean;
  children: ReactNode;
}) {
  const { userId, ready: authReady } = useManagerUserId();

  useEffect(() => {
    return () => setAxisAssistantOpen(false);
  }, []);

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
    if (disabled || !smsTestPortal || !authReady || !userId || isDemoModeActive()) return;
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
  }, [authReady, disabled, userId, catalogScopeKey, capabilityScopeKey, smsCapabilityAttempt, smsTestPortal]);

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

  if (disabled) return <>{children}</>;

  return (
    <PortalAssistantConfigProvider endpoint={activeEndpoint} managerName={managerName ?? null} smsTest={smsTestConfig}>
      <AxisAssistantPresenceContext.Provider value={true}>
          <AssistantConversationProvider
            endpoint={activeEndpoint}
            archiveKey={`${userId ?? "anonymous"}:${workspace.id ?? ""}`}
          >
            <MemoizedLayoutSlot>{children}</MemoizedLayoutSlot>
            <AxisAssistantChrome managerName={managerName} endpoint={activeEndpoint} />
          </AssistantConversationProvider>
      </AxisAssistantPresenceContext.Provider>
    </PortalAssistantConfigProvider>
  );
}
