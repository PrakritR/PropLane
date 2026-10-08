import { useSyncExternalStore } from "react";

import { ASSISTANT_DOCK_COLLAPSED_COOKIE } from "@/lib/assistant-dock-cookie";

type Listener = () => void;

/**
 * The side panel is the only assistant window on desktop, so its open/closed
 * state is the whole story here (`collapsed` is "closed"). It is remembered per
 * device: localStorage is the source of truth, and the cookie mirrors it only so
 * the server can render the layout with the right rail width on first paint.
 */
const PANEL_OPEN_STORAGE_KEY = "axis:assistant-panel-open:v1";

let collapsed = true;
const listeners = new Set<Listener>();

function syncDomAttributes() {
  if (typeof document === "undefined") return;
  document.documentElement.toggleAttribute("data-assistant-dock-collapsed", collapsed);
  document.documentElement.toggleAttribute("data-assistant-dock-expanded", !collapsed);
}

function notify() {
  for (const listener of listeners) listener();
}

function writeCookie(name: string, value: string) {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
}

function readStoredPanelOpen(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PANEL_OPEN_STORAGE_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    return null;
  }
}

function writeStoredPanelOpen(open: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PANEL_OPEN_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // Storage disabled or full: the panel still works, it just is not remembered.
  }
}

export function getAssistantDockCollapsed(): boolean {
  return collapsed;
}

export function setAssistantDockCollapsed(next: boolean): void {
  if (collapsed === next) return;
  collapsed = next;
  writeCookie(ASSISTANT_DOCK_COLLAPSED_COOKIE, next ? "1" : "0");
  writeStoredPanelOpen(!next);
  syncDomAttributes();
  notify();
}

export function subscribeAssistantDockCollapsed(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Seeds the singleton from the SSR cookie, then lets this device's stored
 * choice win. It runs from the rail's mount effect, i.e. after readers rendered
 * earlier in the tree, so it notifies them instead of mutating silently.
 */
export function initAssistantDockState(initial: { collapsed: boolean }): void {
  const stored = readStoredPanelOpen();
  const next = stored === null ? initial.collapsed : !stored;
  const changed = collapsed !== next;
  collapsed = next;
  syncDomAttributes();
  if (changed) notify();
}

/** Reactive read of whether the side panel is closed. */
export function useAssistantDockCollapsed(initial = true): boolean {
  return useSyncExternalStore(subscribeAssistantDockCollapsed, getAssistantDockCollapsed, () => initial);
}

export function expandAssistantDock(): void {
  setAssistantDockCollapsed(false);
}

export function collapseAssistantDock(): void {
  setAssistantDockCollapsed(true);
}

/**
 * A closing rail unmounts the X that had focus; hand it to the top strip's
 * assistant-panel button, the control that reopens the assistant.
 */
export function focusAskPropLane(): void {
  if (typeof document === "undefined") return;
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('[data-attr="portal-assistant-panel"]')?.focus();
  });
}

export function toggleAssistantDock(): void {
  setAssistantDockCollapsed(!collapsed);
}
