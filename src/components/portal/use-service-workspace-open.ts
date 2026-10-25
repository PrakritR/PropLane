"use client";

import { useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { openServiceWorkspace, switchToPropertyPortal } from "@/lib/service/open-service-workspace";
import type { ServiceShellData } from "@/lib/service/service-mode";

/**
 * The open / create behaviour the desktop rail (`ServiceRailTiles`) and the phone menu (`ServiceWorkspaceMenu`)
 * share: `open` runs the admin "open" for a workspace (the server authorizes it) and toasts a refusal;
 * `switchToProperty` is the way out of service mode, back into the viewer's own Property portal (null when the
 * account has no own workspace); `onCreated` is what `AdminNewServiceWorkspace` calls - close the pop-up, toast,
 * let the caller refresh, then open the new one.
 */
export function useServiceWorkspaceOpen(service: ServiceShellData, afterCreate?: () => void) {
  const { showToast } = useAppUi();
  const [createOpen, setCreateOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const open = async (id: string) => {
    setBusyId(id);
    const error = await openServiceWorkspace(id, undefined, { isAdmin: service.isAdmin });
    if (error) {
      setBusyId(null);
      showToast(error);
    }
  };

  const switchToProperty = service.propertyPortalWorkspaceId
    ? async () => {
        const id = service.propertyPortalWorkspaceId!;
        setBusyId(id);
        const error = await switchToPropertyPortal(id);
        if (error) {
          setBusyId(null);
          showToast(error);
        }
      }
    : null;

  const onCreated = (id: string, name: string) => {
    setCreateOpen(false);
    showToast(`${name} created.`);
    afterCreate?.();
    void open(id);
  };

  return { createOpen, setCreateOpen, busyId, open, switchToProperty, onCreated };
}
