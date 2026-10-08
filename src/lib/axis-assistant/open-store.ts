import { ASSISTANT_DOCK_INPUT_ID } from "@/components/portal/assistant-dock-input-id";
import { isAssistantSheetViewportNow } from "@/lib/axis-assistant/viewport";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { expandAssistantDock } from "@/lib/axis-assistant/dock-store";

type Listener = () => void;

/**
 * The assistant has ONE window: the side panel on desktop (`lg` and up, its
 * state lives in `dock-store`) and a full-screen sheet below `lg`. This store is
 * the phone sheet's open flag; `openAxisAssistant()` picks the right surface for
 * the current viewport so callers never need to know which one it is.
 */
let open = false;
const listeners = new Set<Listener>();

export function getAxisAssistantOpen(): boolean {
  return open;
}

export function setAxisAssistantOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export function subscribeAxisAssistantOpen(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Focus the composer once the surface that was just opened has mounted. */
function focusAssistantInput(): void {
  if (typeof document === "undefined") return;
  // The native shell keeps the keyboard down until the user taps the field.
  if (document.documentElement.hasAttribute("data-native")) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      (document.getElementById(ASSISTANT_DOCK_INPUT_ID) as HTMLTextAreaElement | null)?.focus();
    });
  });
}

/** Opens the assistant: the side panel on lg+, the full-screen sheet below. */
export function openAxisAssistant(): void {
  // The /demo sandbox draws its own scripted assistant from this flag, on every
  // viewport; it never mounts the real side panel.
  if (isDemoModeActive() || isAssistantSheetViewportNow()) {
    setAxisAssistantOpen(true);
  } else {
    expandAssistantDock();
  }
  focusAssistantInput();
}

/** Closes the phone sheet. The desktop panel closes through `collapseAssistantDock`. */
export function closeAxisAssistant(): void {
  setAxisAssistantOpen(false);
}

// --- scripted prompt channel (used by the /demo "Run demo" auto-play) ---------
type PromptListener = (prompt: string) => void;
const promptListeners = new Set<PromptListener>();

export function subscribeAxisAssistantPrompt(listener: PromptListener): () => void {
  promptListeners.add(listener);
  return () => promptListeners.delete(listener);
}

/** Open the assistant and submit a prompt programmatically. */
export function sendAxisAssistantPrompt(prompt: string): void {
  openAxisAssistant();
  for (const listener of promptListeners) listener(prompt);
}
