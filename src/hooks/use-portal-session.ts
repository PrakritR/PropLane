"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import posthog from "posthog-js";
import { setPortalSessionViewer } from "@/lib/auth/portal-session-gate";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { getBrowserSessionWithRetry } from "@/lib/supabase/safe-browser-session";
import {
  demoSessionForRole,
  getDemoRole,
  isDemoModeActive,
  subscribeDemoRole,
} from "@/lib/demo/demo-session";

type PortalSessionSnapshot = {
  userId: string | null;
  email: string | null;
  ready: boolean;
};

let snapshot: PortalSessionSnapshot = {
  userId: null,
  email: null,
  ready: false,
};
let initialized = false;
let storeGeneration = 0;
let stopSessionRetry: (() => void) | null = null;
/** Quiet retry cadence once the initial backoff has been exhausted. */
const SESSION_DEFERRED_RETRY_MS = 30_000;
let authSubscription: { unsubscribe: () => void } | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function updateSnapshot(next: PortalSessionSnapshot) {
  if (
    snapshot.userId === next.userId &&
    snapshot.email === next.email &&
    snapshot.ready === next.ready
  ) {
    return;
  }
  snapshot = next;
  emit();
}

function applySession(session: Session | null) {
  const userId = session?.user?.id ?? null;
  if (userId) {
    try {
      posthog.identify(userId);
    } catch {
      /* analytics must never break the portal */
    }
  }
  // Publish the identity BEFORE the snapshot so any cache listening for an
  // account change has already dropped the previous account's rows by the time
  // a subscribed component re-renders and reads from it.
  setPortalSessionViewer(userId);
  updateSnapshot({
    userId,
    email: session?.user?.email ?? null,
    ready: true,
  });
}

function ensurePortalSessionStore() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  let supabase: ReturnType<typeof createSupabaseBrowserClient>;
  try {
    supabase = createSupabaseBrowserClient();
  } catch {
    updateSnapshot({ userId: null, email: null, ready: true });
    return;
  }

  // A transient failure (offline on resume, 429, 5xx) says nothing about
  // whether the visitor is signed in. Never publish "no user" for it: keep
  // `ready: false`, retry with backoff, and retry again when the app comes
  // back online or into the foreground. Only a settled answer is published.
  const generation = ++storeGeneration;
  const cancelled = () => generation !== storeGeneration;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let resolved = false;
  const resolveSession = async (): Promise<void> => {
    if (cancelled() || resolved) return;
    try {
      const { session, settled } = await getBrowserSessionWithRetry(supabase, { isCancelled: cancelled });
      if (cancelled()) return;
      if (settled) {
        resolved = true;
        applySession(session);
        return;
      }
    } catch {
      /* fall through to the deferred retry */
    }
    if (cancelled() || resolved) return;
    retryTimer = setTimeout(() => void resolveSession(), SESSION_DEFERRED_RETRY_MS);
  };
  void resolveSession();
  const retryNow = () => {
    if (cancelled() || resolved) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    void resolveSession();
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") retryNow();
  };
  window.addEventListener("online", retryNow);
  document.addEventListener("visibilitychange", onVisible);
  stopSessionRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    window.removeEventListener("online", retryNow);
    document.removeEventListener("visibilitychange", onVisible);
  };

  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((event: AuthChangeEvent, session: Session | null) => {
    // INITIAL_SESSION with no session is auth-js reporting "I could not load
    // one right now" as often as "there is none"; resolveSession above owns
    // that answer. An explicit SIGNED_OUT is always honoured.
    if (event === "INITIAL_SESSION" && !session) return;
    if (session || event === "SIGNED_OUT") resolved = true;
    applySession(session);
  });
  authSubscription = subscription;
}

export function usePortalSession(initial?: {
  userId?: string | null;
  email?: string | null;
}): PortalSessionSnapshot {
  const [state, setState] = useState<PortalSessionSnapshot>(() => ({
    userId: snapshot.userId ?? initial?.userId ?? null,
    email: snapshot.email ?? initial?.email ?? null,
    ready: snapshot.ready || Boolean(initial?.userId),
  }));

  // On the public `/demo` sandbox, report a fixed synthetic session for the
  // active demo role so the real portal panels render their seeded data. This
  // never touches Supabase and is scoped to `/demo` by pathname.
  const demoRole = useSyncExternalStore(subscribeDemoRole, getDemoRole, () => "manager" as const);

  // `isDemoModeActive()` reads `window.location`, which the server can't see —
  // the page is server-rendered normally, so evaluating it during render would
  // report "not demo" on the server and "demo" on the client's first paint,
  // a hydration mismatch. Only switch to the demo session after mount.
  const [demoActive, setDemoActive] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration-safe demo-mode detection on mount
    setDemoActive(isDemoModeActive());
  }, []);

  useEffect(() => {
    if (isDemoModeActive()) return;
    ensurePortalSessionStore();
    const sync = () => {
      setState({
        userId: snapshot.userId ?? initial?.userId ?? null,
        email: snapshot.email ?? initial?.email ?? null,
        ready: snapshot.ready || Boolean(initial?.userId),
      });
    };
    listeners.add(sync);
    sync();
    return () => {
      listeners.delete(sync);
      if (listeners.size === 0 && authSubscription) {
        authSubscription.unsubscribe();
        authSubscription = null;
        storeGeneration += 1;
        stopSessionRetry?.();
        stopSessionRetry = null;
        initialized = false;
      }
    };
  }, [initial?.email, initial?.userId]);

  if (demoActive) return demoSessionForRole(demoRole);

  return state;
}
