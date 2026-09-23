import { useSyncExternalStore } from "react";

import {
  ASSISTANT_DOCK_COLLAPSED_COOKIE,
  ASSISTANT_DOCKED_COOKIE,
} from "@/lib/assistant-dock-cookie";

type Listener = () => void;

let collapsed = true;
let docked = false;
const listeners = new Set<Listener>();

function syncDomAttributes() {
  if (typeof document === "undefined") return;
  document.documentElement.toggleAttribute("data-assistant-dock-collapsed", collapsed);
  document.documentElement.toggleAttribute("data-assistant-dock-expanded", docked && !collapsed);
  document.documentElement.toggleAttribute("data-assistant-docked", docked);
}

function notify() {
  for (const listener of listeners) listener();
}

function writeCookie(name: string, value: string) {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
}

export function getAssistantDockCollapsed(): boolean {
  return collapsed;
}

export function getAssistantDocked(): boolean {
  return docked;
}

export function setAssistantDockCollapsed(next: boolean): void {
  if (collapsed === next) return;
  collapsed = next;
  writeCookie(ASSISTANT_DOCK_COLLAPSED_COOKIE, next ? "1" : "0");
  syncDomAttributes();
  notify();
}

export function setAssistantDocked(next: boolean): void {
  if (docked === next) return;
  docked = next;
  writeCookie(ASSISTANT_DOCKED_COOKIE, next ? "1" : "0");
  syncDomAttributes();
  notify();
}

export function subscribeAssistantDockCollapsed(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function subscribeAssistantDocked(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Seeds the singleton from the SSR cookie values. It runs from the rail's mount
 * effect, i.e. after readers rendered earlier in the tree (the Settings picker
 * lives in `{children}`), so it notifies them instead of mutating silently.
 */
export function initAssistantDockState(initial: { collapsed: boolean; docked: boolean }): void {
  const changed = collapsed !== initial.collapsed || docked !== initial.docked;
  collapsed = initial.collapsed;
  docked = initial.docked;
  syncDomAttributes();
  if (changed) notify();
}

/** Reactive read of the "pinned to the right rail" preference. */
export function useAssistantDocked(): boolean {
  return useSyncExternalStore(subscribeAssistantDocked, getAssistantDocked, () => false);
}

export function expandAssistantDock(): void {
  setAssistantDocked(true);
  setAssistantDockCollapsed(false);
}

export function collapseAssistantDock(): void {
  setAssistantDockCollapsed(true);
}

/** Leave rail mode entirely (portals with no Settings toggle to undock from). */
export function undockAssistantFromRail(): void {
  setAssistantDocked(false);
  setAssistantDockCollapsed(true);
}

/**
 * A closing rail unmounts the ✕ that had focus; hand it to the top bar's Ask
 * PropLane, the control that reopens the assistant.
 */
export function focusAskPropLane(): void {
  if (typeof document === "undefined") return;
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('[data-attr="portal-ask-proplane"]')?.focus();
  });
}

export function toggleAssistantDock(): void {
  setAssistantDockCollapsed(!collapsed);
}
