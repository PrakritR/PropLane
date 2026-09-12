"use client";

import { createContext, useContext, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

/**
 * A page's tool controls (Filter · Settings · Share) belong beside its title,
 * not in a white bar of their own under it.
 *
 * Many tabs have no status pills and no search, so the list toolbar under the
 * heading was a full-width card whose only contents were two icons on the
 * right — an empty bar that read as a missing search field. The shell that
 * owns the title provides this slot; the list chrome, when it has nothing but
 * controls, publishes them into it and renders nothing in the body.
 *
 * The slot is an external store, not React state on the provider: a publish
 * re-renders only the host, never the provider's subtree, so the publisher's
 * effect cannot feed itself (a state-based slot looped on "maximum update
 * depth" the first time it was tried).
 */
type SlotStore = {
  node: ReactNode;
  /** Mounted hosts — a publisher only claims the slot when there is somewhere to render. */
  hosts: number;
  listeners: Set<() => void>;
};

function emit(store: SlotStore) {
  for (const l of store.listeners) l();
}

function useSlotValue<T>(store: SlotStore | null, read: (s: SlotStore) => T, fallback: T): T {
  return useSyncExternalStore(
    (onChange) => {
      if (!store) return () => {};
      store.listeners.add(onChange);
      return () => store.listeners.delete(onChange);
    },
    () => (store ? read(store) : fallback),
    () => fallback,
  );
}

const SlotContext = createContext<SlotStore | null>(null);

export function PortalTitleActionsProvider({ children }: { children: ReactNode }) {
  const store = useRef<SlotStore | null>(null);
  if (!store.current) store.current = { node: null, hosts: 0, listeners: new Set() };
  return <SlotContext.Provider value={store.current}>{children}</SlotContext.Provider>;
}

/** Where the published controls appear — the title row's right edge. */
export function PortalTitleActionsHost({ className }: { className?: string }) {
  const store = useContext(SlotContext);
  const node = useSlotValue(store, (s) => s.node, null);
  useLayoutEffect(() => {
    if (!store) return;
    store.hosts += 1;
    emit(store);
    return () => {
      store.hosts -= 1;
      emit(store);
    };
  }, [store]);
  if (!node) return null;
  return (
    <div className={className} data-slot="portal-title-actions">
      {node}
    </div>
  );
}

/** True while something is published into the nearest slot — for a header that hides itself when empty. */
export function useTitleActionsPublished(): boolean {
  const store = useContext(SlotContext);
  return useSlotValue(store, (s) => s.node != null, false);
}

/**
 * Publish `node` into the nearest title slot. Returns true when a slot with a
 * mounted host exists (the caller then renders nothing in place), false when
 * it must fall back to rendering the controls itself.
 */
export function usePublishTitleActions(node: ReactNode, enabled: boolean): boolean {
  const store = useContext(SlotContext);
  const hosts = useSlotValue(store, (s) => s.hosts, 0);
  const active = Boolean(store) && enabled && hosts > 0;
  useLayoutEffect(() => {
    if (!active || !store) return;
    store.node = node;
    emit(store);
    return () => {
      store.node = null;
      emit(store);
    };
  });
  return active;
}
