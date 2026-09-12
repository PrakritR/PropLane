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
const MEDIA_NOOP = () => () => {};

/** Tailwind's `md` — the one breakpoint a detail header splits its actions on. */
const MD_UP = "(min-width: 768px)";

/**
 * True when the viewport is `md` or wider. A header that mounts one host in
 * its title row and another beneath it (desktop vs phone) gives them the two
 * halves of this one query, so the published node is in the DOM exactly once
 * — hiding the other copy with CSS would leave two "Download" buttons for a
 * screen reader and a test. Without matchMedia (SSR) it counts as wide.
 */
function useMdUp(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return MEDIA_NOOP();
      const list = window.matchMedia(MD_UP);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => (typeof window === "undefined" || !window.matchMedia ? true : window.matchMedia(MD_UP).matches),
    () => true,
  );
}

export function PortalTitleActionsHost({
  className,
  breakpoint,
}: {
  className?: string;
  /** Render only on one side of `md`; omit to render at every width. */
  breakpoint?: "md-up" | "below-md";
}) {
  const store = useContext(SlotContext);
  const node = useSlotValue(store, (s) => s.node, null);
  const mdUp = useMdUp();
  const matches = breakpoint === "md-up" ? mdUp : breakpoint === "below-md" ? !mdUp : true;
  useLayoutEffect(() => {
    if (!store) return;
    store.addHost(1);
    return () => store.addHost(-1);
  }, [store]);
  if (!node || !matches) return null;
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
