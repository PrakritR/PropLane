"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import posthog from "posthog-js";
import { setPortalSessionViewer } from "@/lib/auth/portal-session-gate";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { safeBrowserGetSession } from "@/lib/supabase/safe-browser-session";
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

  void (async () => {
    try {
      const { session } = await safeBrowserGetSession(supabase);
      applySession(session);
    } catch {
      updateSnapshot({ userId: null, email: null, ready: true });
    }
  })();

  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
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
        initialized = false;
      }
    };
  }, [initial?.email, initial?.userId]);

  if (demoActive) return demoSessionForRole(demoRole);

  return state;
}
