"use client";

import { ManagerPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";

/** @deprecated Use ManagerPortalSettingsModal with initialTab="tours". */
export function TourReminderSettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return <ManagerPortalSettingsModal open={open} onClose={onClose} initialTab="tours" scoped />;
}
