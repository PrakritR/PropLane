"use client";

import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";

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
class SlotStore {
  node: ReactNode = null;
  /** Mounted hosts — a publisher only claims the slot when there is somewhere to render. */
  hosts = 0;
  private listeners = new Set<() => void>();
  subscribe = (onChange: () => void) => {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  };
  private emit() {
    for (const l of this.listeners) l();
  }
  publish(node: ReactNode) {
    this.node = node;
    this.emit();
  }
  addHost(delta: 1 | -1) {
    this.hosts += delta;
    this.emit();
  }
}

const SlotContext = createContext<SlotStore | null>(null);

function useSlotValue<T>(store: SlotStore | null, read: (s: SlotStore) => T, fallback: T): T {
  return useSyncExternalStore(
    (onChange) => (store ? store.subscribe(onChange) : () => {}),
    () => (store ? read(store) : fallback),
    () => fallback,
  );
}

export function PortalTitleActionsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new SlotStore());
  return <SlotContext.Provider value={store}>{children}</SlotContext.Provider>;
}

/** Where the published controls appear — the title row's right edge. */
export function PortalTitleActionsHost({ className }: { className?: string }) {
  const store = useContext(SlotContext);
  const node = useSlotValue(store, (s) => s.node, null);
  useLayoutEffect(() => {
    if (!store) return;
    store.addHost(1);
    return () => store.addHost(-1);
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
    store.publish(node);
    return () => store.publish(null);
  });
  return active;
}
