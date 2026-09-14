"use client";

import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

function filterDraftValuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((value, index) => Object.is(value, b[index]));
  }
  return Object.is(a, b);
}

type DraftEntry = {
  applied: unknown;
  draft: unknown;
  onApply: (next: unknown) => void;
  resetValue: unknown;
  /** Stable caller-chosen name, when the field opted into being readable by one. */
  name?: string;
};

type PortalFilterDeferContextValue = {
  register: (
    id: string,
    applied: unknown,
    onApply: (next: unknown) => void,
    resetValue: unknown,
    name?: string,
  ) => void;
  unregister: (id: string) => void;
  syncApplied: (id: string, applied: unknown) => void;
  getDraft: <T>(id: string, fallback: T) => T;
  /** Read a field's PENDING value by the stable name it registered under. */
  getDraftByName: <T>(name: string, fallback: T) => T;
  setDraft: <T>(id: string, next: T) => void;
  subscribe: (listener: () => void) => () => void;
  commitAll: () => void;
  resetAll: () => void;
  snapshotFromApplied: () => void;
};

/**
 * The name the shared property field registers its draft under.
 *
 * A constant rather than a literal because the field lives in one file and the
 * panels that read it live in others — a typo on either side would silently
 * fall back to the applied value and produce a count that is quietly wrong
 * rather than obviously broken.
 */
export const PORTAL_FILTER_DRAFT_PROPERTY_FILTERS = "propertyFilters";

const PortalFilterDeferContext = createContext<PortalFilterDeferContextValue | null>(null);

export function PortalFilterDeferProvider({
  children,
  controllerRef,
}: {
  children: ReactNode;
  controllerRef?: React.MutableRefObject<PortalFilterDeferController | null>;
}) {
  const entriesRef = useRef(new Map<string, DraftEntry>());
  const listenersRef = useRef(new Set<() => void>());
  const [, bump] = useState(0);

  const notify = useCallback(() => {
    bump((n) => n + 1);
    listenersRef.current.forEach((listener) => listener());
  }, []);

  const register = useCallback(
    (
      id: string,
      applied: unknown,
      onApply: (next: unknown) => void,
      resetValue: unknown,
      name?: string,
    ) => {
      const existing = entriesRef.current.get(id);
      entriesRef.current.set(id, {
        applied,
        draft: existing?.draft ?? applied,
        onApply,
        resetValue,
        name,
      });
    },
    [],
  );

  const unregister = useCallback((id: string) => {
    entriesRef.current.delete(id);
  }, []);

  const syncApplied = useCallback((id: string, applied: unknown) => {
    const entry = entriesRef.current.get(id);
    if (!entry) return;
    entry.applied = applied;
  }, []);

  const getDraft = useCallback(<T,>(id: string, fallback: T): T => {
    const entry = entriesRef.current.get(id);
    if (!entry) return fallback;
    return entry.draft as T;
  }, []);

  /*
   * Reading a pending value from OUTSIDE the field that owns it.
   *
   * The whole point of this provider is that the list behind an open filter
   * panel does not move while you are choosing — so the applied state, which is
   * what the page renders from, is deliberately stale until you commit. A
   * footer that promises "Show 12 tasks" therefore cannot read the page's own
   * state: it has to ask what is PENDING, which is what this is for. A field
   * only becomes readable this way when it registers a stable name, so an
   * anonymous field cannot be read by accident.
   */
  const getDraftByName = useCallback(<T,>(name: string, fallback: T): T => {
    for (const entry of entriesRef.current.values()) {
      if (entry.name === name) return entry.draft as T;
    }
    return fallback;
  }, []);

  const setDraft = useCallback(
    <T,>(id: string, next: T) => {
      const entry = entriesRef.current.get(id);
      if (!entry) return;
      entry.draft = next;
      notify();
    },
    [notify],
  );

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const commitAll = useCallback(() => {
    for (const entry of entriesRef.current.values()) {
      if (filterDraftValuesEqual(entry.draft, entry.applied)) continue;
      const next = entry.draft;
      entry.applied = next;
      startTransition(() => {
        entry.onApply(next);
      });
    }
  }, []);

  const resetAll = useCallback(() => {
    let changed = false;
    for (const entry of entriesRef.current.values()) {
      if (filterDraftValuesEqual(entry.draft, entry.resetValue)) continue;
      entry.draft = entry.resetValue;
      changed = true;
    }
    if (changed) notify();
  }, [notify]);

  const snapshotFromApplied = useCallback(() => {
    let changed = false;
    for (const entry of entriesRef.current.values()) {
      if (filterDraftValuesEqual(entry.draft, entry.applied)) continue;
      entry.draft = entry.applied;
      changed = true;
    }
    if (changed) notify();
  }, [notify]);

  const controller: PortalFilterDeferController = {
    commitAll,
    resetAll,
    snapshotFromApplied,
  };

  // Published in a layout effect rather than during render: writing a ref while
  // rendering is unsafe under concurrent rendering (a render can be thrown away
  // after the write). Layout timing keeps the controller available to consumers
  // before paint, which is when the commit/reset buttons can first be pressed.
  useLayoutEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = controller;
  });

  const value = useMemo<PortalFilterDeferContextValue>(
    () => ({
      register,
      unregister,
      syncApplied,
      getDraft,
      getDraftByName,
      setDraft,
      subscribe,
      commitAll,
      resetAll,
      snapshotFromApplied,
    }),
    [
      register,
      unregister,
      syncApplied,
      getDraft,
      getDraftByName,
      setDraft,
      subscribe,
      commitAll,
      resetAll,
      snapshotFromApplied,
    ],
  );

  return <PortalFilterDeferContext.Provider value={value}>{children}</PortalFilterDeferContext.Provider>;
}

export type PortalFilterDeferController = {
  commitAll: () => void;
  resetAll: () => void;
  snapshotFromApplied: () => void;
};

/**
 * While inside an open {@link PortalFilterSortSheet}, edits stay in a draft until the
 * sheet closes (X, backdrop, or another control). Outside the sheet, changes apply immediately.
 */
export function usePortalFilterDraft<T>(
  applied: T,
  onApply: (next: T) => void,
  resetValue: T,
  /**
   * Optional stable name making this field's PENDING value readable from
   * elsewhere in the same panel (see {@link usePortalFilterDraftValues}). Names
   * must be unique within one panel.
   */
  name?: string,
): [T, (next: T) => void] {
  const id = useId();
  const ctx = useContext(PortalFilterDeferContext);
  const [, setTick] = useState(0);
  const appliedRef = useRef(applied);
  const onApplyRef = useRef(onApply);
  const resetValueRef = useRef(resetValue);
  const nameRef = useRef(name);

  // Latest-value refs, synced in a layout effect for the same reason. It must be
  // `useLayoutEffect` rather than `useEffect`: `ensureRegistered` below reads
  // these from layout effects, and layout effects run in declaration order, so a
  // plain effect here would feed the consumer the previous render's values.
  useLayoutEffect(() => {
    appliedRef.current = applied;
    onApplyRef.current = onApply;
    resetValueRef.current = resetValue;
    nameRef.current = name;
  });

  const ensureRegistered = useCallback(() => {
    if (!ctx) return;
    ctx.register(
      id,
      appliedRef.current,
      (next) => onApplyRef.current(next as T),
      resetValueRef.current,
      nameRef.current,
    );
  }, [ctx, id]);

  /* Register in layout — not during render. A render-time register paired with a layout
     cleanup on `ctx` change unregisters AFTER the render register and leaves no entry
     until the next paint (portaled filter picks then no-op). */
  useLayoutEffect(() => {
    if (!ctx) return;
    ensureRegistered();
    return () => ctx.unregister(id);
  }, [ctx, id, ensureRegistered]);

  useLayoutEffect(() => {
    ctx?.syncApplied(id, applied);
  }, [ctx, id, applied]);

  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribe(() => setTick((n) => n + 1));
  }, [ctx]);

  const setDraft = useCallback(
    (next: T) => {
      if (!ctx) return;
      ensureRegistered();
      ctx.setDraft(id, next);
    },
    [ctx, id, ensureRegistered],
  );

  if (!ctx) {
    return [applied, onApply];
  }

  const draft = ctx.getDraft(id, applied);
  return [draft, setDraft];
}

/**
 * The PENDING value of every named field in the surrounding panel.
 *
 * Pass the applied values as the fallback: outside a panel (or before a field
 * has registered) there is no draft, and the applied value is then the honest
 * answer. Re-renders whenever any draft changes, so a count derived from this
 * tracks the panel as it is edited rather than as it was committed.
 */
export function usePortalFilterDraftValues<T extends Record<string, unknown>>(applied: T): T {
  const ctx = useContext(PortalFilterDeferContext);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribe(() => setTick((n) => n + 1));
  }, [ctx]);

  if (!ctx) return applied;
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(applied)) {
    out[key] = ctx.getDraftByName(key, applied[key]);
  }
  return out as T;
}
