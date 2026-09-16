"use client";

import { useEffect, useState } from "react";
import {
  WORKSPACE_SELECTION_EVENT,
  activeWorkspaceIdentity,
  selectedWorkspaceId,
} from "@/lib/workspaces/selection";

/**
 * The switcher's active workspace id, re-rendering when it changes. A work
 * number and a work email belong to a workspace, so any reader of those
 * statuses depends on this — put it in the effect's dependency list and the
 * read repeats on a switch, and only on a switch.
 */
export function useSelectedWorkspaceId(): string | null {
  const [id, setId] = useState<string | null>(() => selectedWorkspaceId());
  useEffect(() => {
    const onSelection = () => setId(selectedWorkspaceId());
    onSelection();
    window.addEventListener(WORKSPACE_SELECTION_EVENT, onSelection);
    return () => window.removeEventListener(WORKSPACE_SELECTION_EVENT, onSelection);
  }, []);
  return id;
}

/** Active workspace id plus whether it is the account default (legacy assistant id). */
export function useActiveWorkspaceIdentity(): { id: string | null; isDefault: boolean } {
  const id = useSelectedWorkspaceId();
  const [isDefault, setIsDefault] = useState(() => activeWorkspaceIdentity()?.isDefault ?? true);
  useEffect(() => {
    const onSelection = () => setIsDefault(activeWorkspaceIdentity()?.isDefault ?? true);
    onSelection();
    window.addEventListener(WORKSPACE_SELECTION_EVENT, onSelection);
    return () => window.removeEventListener(WORKSPACE_SELECTION_EVENT, onSelection);
  }, []);
  return { id, isDefault };
}
