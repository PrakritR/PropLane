import type { Session } from "@supabase/supabase-js";
import { isStaleRefreshTokenError } from "@/lib/supabase/safe-browser-session";

// Supabase getSession() already renews inside its 90-second expiry margin. This
// slightly wider window gives a resumed native app time to renew before its next
// request without refreshing an otherwise healthy one-hour session.
export const PORTAL_SESSION_REFRESH_MARGIN_MS = 2 * 60 * 1000;

export type PortalSessionRefreshResult =
  | "no-session"
  | "not-due"
  | "refreshed"
  | "owner-changed"
  | "permanent-failure"
  | "transient-failure";

type SessionResponse = {
  session: Session | null;
  error: unknown;
};

type RefreshResponse = {
  data: { session: Session | null };
  error: unknown;
};

export type PortalSessionRefreshDependencies = {
  /** A non-destructive adapter around auth.getSession(). */
  getSession: () => Promise<SessionResponse>;
  refreshSession: () => Promise<RefreshResponse>;
  clearStaleAuth: () => Promise<void>;
  markSignedIn: () => void;
  now?: () => number;
};

export type PortalSessionRefreshCoordinator = {
  refresh: () => Promise<PortalSessionRefreshResult>;
  /** Establishes the subscription's current value without implying a transition. */
  observeInitialSession: (session: Session | null) => void;
  /** Synchronously invalidates work when the singleton auth client changes session. */
  observeAuthLifecycle: (session: Session | null) => void;
  /** Detaches pending work when its component lifecycle ends. */
  invalidate: () => void;
};

function ownerId(session: Session | null): string | null {
  return session?.user?.id ?? null;
}

function sessionIdentity(session: Session | null): string | null {
  if (!session?.user?.id) return null;
  // The refresh token distinguishes a new login by the same user. It remains
  // process-local and is never logged or persisted by this coordinator.
  return `${session.user.id}:${session.refresh_token}`;
}

function refreshIsDue(session: Session, now: number): boolean {
  if (typeof session.expires_at !== "number") return false;
  return session.expires_at * 1000 - now <= PORTAL_SESSION_REFRESH_MARGIN_MS;
}

/**
 * Coordinates portal keepalive work across layout remounts and resume signals.
 * Auth lifecycle events synchronously invalidate stale reads and refreshes,
 * including a sign-out and new sign-in by the same user.
 */
export function createPortalSessionRefreshCoordinator(
  dependencies: PortalSessionRefreshDependencies,
): PortalSessionRefreshCoordinator {
  const now = dependencies.now ?? Date.now;
  const inFlightBySession = new Map<string, Promise<PortalSessionRefreshResult>>();
  let activeSessionIdentity: string | null = null;
  let activeOwnerId: string | null = null;
  let sessionGeneration = 0;
  // Session generation may advance when another keepalive read establishes the
  // current identity. Lifecycle epoch advances only for an auth event or an
  // owning component disposal, which stale work must never cross.
  let lifecycleEpoch = 0;
  let nextInvocationId = 0;
  let latestObservedInvocationId = 0;

  const observeSession = (session: Session | null): number => {
    const nextIdentity = sessionIdentity(session);
    if (activeSessionIdentity !== nextIdentity) {
      activeSessionIdentity = nextIdentity;
      activeOwnerId = ownerId(session);
      sessionGeneration += 1;
      inFlightBySession.clear();
    }
    return sessionGeneration;
  };

  const observeAuthLifecycle = (session: Session | null) => {
    lifecycleEpoch += 1;
    inFlightBySession.clear();
    observeSession(session);
  };

  const observeInitialSession = (session: Session | null) => {
    observeSession(session);
  };

  const invalidate = () => {
    lifecycleEpoch += 1;
    inFlightBySession.clear();
  };

  const clearPermanentFailureIfCurrent = async (
    expectedGeneration: number,
    expectedLifecycleEpoch: number,
  ): Promise<PortalSessionRefreshResult> => {
    if (
      lifecycleEpoch !== expectedLifecycleEpoch ||
      sessionGeneration !== expectedGeneration
    ) {
      return "owner-changed";
    }
    await dependencies.clearStaleAuth();
    return "permanent-failure";
  };

  const readSession = async (
    expectedGeneration: number,
    expectedLifecycleEpoch: number,
  ): Promise<SessionResponse | PortalSessionRefreshResult> => {
    try {
      const response = await dependencies.getSession();
      if (lifecycleEpoch !== expectedLifecycleEpoch) return "owner-changed";
      if (sessionGeneration !== expectedGeneration) {
        // Concurrent reads of the same live session may have established the
        // generation first. Only that exact session can remain eligible.
        if (!response.error && sessionIdentity(response.session) === activeSessionIdentity) {
          return response;
        }
        return "owner-changed";
      }
      if (!response.error) return response;
      if (isStaleRefreshTokenError(response.error)) {
        return clearPermanentFailureIfCurrent(
          expectedGeneration,
          expectedLifecycleEpoch,
        );
      }
      return "transient-failure";
    } catch (error) {
      if (
        lifecycleEpoch !== expectedLifecycleEpoch ||
        sessionGeneration !== expectedGeneration
      ) {
        return "owner-changed";
      }
      if (isStaleRefreshTokenError(error)) {
        return clearPermanentFailureIfCurrent(
          expectedGeneration,
          expectedLifecycleEpoch,
        );
      }
      return "transient-failure";
    }
  };

  const refresh = async (): Promise<PortalSessionRefreshResult> => {
    const invocationId = ++nextInvocationId;
    const generationBeforeRead = sessionGeneration;
    const invocationLifecycleEpoch = lifecycleEpoch;
    const firstRead = await readSession(
      generationBeforeRead,
      invocationLifecycleEpoch,
    );
    if (typeof firstRead === "string") return firstRead;
    // A lifecycle callback can run after readSession's final check but before
    // this continuation resumes. Do not let that detached read observe state
    // or start any further SDK work.
    if (lifecycleEpoch !== invocationLifecycleEpoch) return "owner-changed";

    const session = firstRead.session;
    const identity = sessionIdentity(session);
    // A concurrent refresh can rotate the session after the helper validates
    // its read but before this continuation runs, even without an auth event.
    // Do not let that older snapshot replace the newly observed identity.
    if (sessionGeneration !== generationBeforeRead && identity !== activeSessionIdentity) {
      return "owner-changed";
    }
    let generation: number;
    if (invocationId < latestObservedInvocationId) {
      if (identity !== activeSessionIdentity) return "owner-changed";
      generation = sessionGeneration;
    } else {
      latestObservedInvocationId = invocationId;
      generation = observeSession(session);
    }

    const sessionOwnerId = ownerId(session);
    if (!session || !sessionOwnerId || !identity) return "no-session";
    dependencies.markSignedIn();
    if (!refreshIsDue(session, now())) return "not-due";

    const existing = inFlightBySession.get(identity);
    if (existing) return existing;

    const isCurrentSession = () =>
      lifecycleEpoch === invocationLifecycleEpoch &&
      activeSessionIdentity === identity &&
      activeOwnerId === sessionOwnerId &&
      sessionGeneration === generation;

    const refreshWork = (async (): Promise<PortalSessionRefreshResult> => {
      // getSession() may have renewed an expired token while this request was
      // being coalesced. Re-read before explicitly rotating the refresh token.
      const latestRead = await readSession(generation, invocationLifecycleEpoch);
      if (typeof latestRead === "string") return latestRead;
      if (lifecycleEpoch !== invocationLifecycleEpoch) return "owner-changed";
      const latestSession = latestRead.session;
      if (!isCurrentSession() || sessionIdentity(latestSession) !== identity) {
        return "owner-changed";
      }
      if (!latestSession) return "no-session";

      dependencies.markSignedIn();
      if (!refreshIsDue(latestSession, now())) return "not-due";

      try {
        const { data, error } = await dependencies.refreshSession();
        if (!isCurrentSession()) return "owner-changed";
        if (error) {
          if (isStaleRefreshTokenError(error)) {
            return clearPermanentFailureIfCurrent(
              generation,
              invocationLifecycleEpoch,
            );
          }
          return "transient-failure";
        }

        if (!data.session) return "transient-failure";
        // A TOKEN_REFRESHED callback may advance the generation before this
        // promise resolves. Treat that completion as detached too: a stale SDK
        // operation can emit the same callback after a real account transition.
        if (ownerId(data.session) !== sessionOwnerId) return "owner-changed";
        observeSession(data.session);
        dependencies.markSignedIn();
        return "refreshed";
      } catch (error) {
        if (!isCurrentSession()) return "owner-changed";
        if (isStaleRefreshTokenError(error)) {
          return clearPermanentFailureIfCurrent(
            generation,
            invocationLifecycleEpoch,
          );
        }
        return "transient-failure";
      }
    })();

    inFlightBySession.set(identity, refreshWork);
    try {
      const result = await refreshWork;
      if (lifecycleEpoch !== invocationLifecycleEpoch) return "owner-changed";
      return result;
    } finally {
      if (inFlightBySession.get(identity) === refreshWork) {
        inFlightBySession.delete(identity);
      }
    }
  };

  return { refresh, observeInitialSession, observeAuthLifecycle, invalidate };
}
