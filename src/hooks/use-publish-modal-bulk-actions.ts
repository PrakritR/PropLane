"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * Publishes bulk-action chrome into a parent modal footer.
 *
 * Calling `onBulkActionsChange` with fresh JSX every render makes the parent
 * setState and re-render, which recreates the child and retriggers a naive
 * `useEffect` — infinite loop. Only notify when `signature` changes.
 */
export function usePublishModalBulkActions(
  onBulkActionsChange: ((actions: ReactNode | null) => void) | undefined,
  signature: string,
  actions: ReactNode | null,
) {
  const publishedSignatureRef = useRef<string | null>(null);
  const actionsRef = useRef(actions);
  const onChangeRef = useRef(onBulkActionsChange);

  useLayoutEffect(() => {
    actionsRef.current = actions;
    onChangeRef.current = onBulkActionsChange;
  });

  useLayoutEffect(() => {
    const notify = onChangeRef.current;
    if (!notify) return;

    if (publishedSignatureRef.current === signature) return;
    publishedSignatureRef.current = signature;

    notify(signature ? actionsRef.current : null);
  }, [signature, onBulkActionsChange]);

  useLayoutEffect(() => {
    return () => {
      publishedSignatureRef.current = null;
      onChangeRef.current?.(null);
    };
  }, []);
}
