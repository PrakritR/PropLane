"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadMoveInForms, MOVE_IN_FORMS_CHANGED, type MoveInFormList } from "@/lib/move-in-forms/client";

const EMPTY: MoveInFormList = { forms: [], unread: 0 };

/**
 * The manager's move-in form list. Goes through `loadMoveInForms`, so the shared TTL and the
 * in-flight guard apply; a write anywhere (send, remind, cancel) clears that cache and fires
 * `MOVE_IN_FORMS_CHANGED`, which re-reads here. There is no timer.
 */
export function useManagerMoveInForms(
  userId: string | null,
  query: { applicationId?: string } = {},
  /** False = do not fetch at all (a record tab that is not open). */
  enabled = true,
) {
  const [list, setList] = useState<MoveInFormList>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const version = useRef(0);
  const live = useRef(true);
  const applicationId = query.applicationId;

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const refresh = useCallback(
    async (force = false) => {
      if (!enabled) return;
      const mine = ++version.current;
      try {
        const value = await loadMoveInForms(userId ?? "demo", "manager", applicationId ? { applicationId } : {}, force);
        if (live.current && mine === version.current) {
          setList(value);
          setError("");
        }
      } catch (e) {
        if (live.current && mine === version.current) setError(e instanceof Error ? e.message : "Couldn't load move-in forms");
      } finally {
        if (live.current && mine === version.current) setLoading(false);
      }
    },
    [userId, applicationId, enabled],
  );

  useEffect(() => {
    // Subscribes this view to an external server snapshot.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const changed = () => void refresh(true);
    const refocus = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener(MOVE_IN_FORMS_CHANGED, changed);
    document.addEventListener("visibilitychange", refocus);
    return () => {
      window.removeEventListener(MOVE_IN_FORMS_CHANGED, changed);
      document.removeEventListener("visibilitychange", refocus);
    };
  }, [refresh]);

  const retry = useCallback(() => {
    setLoading(true);
    setError("");
    void refresh(true);
  }, [refresh]);

  return { list, loading, error, retry, refresh };
}
