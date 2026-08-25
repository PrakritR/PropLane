"use client";

import { ManagerPortalSettingsModal } from "@/components/portal/manager-portal-settings-modal";

/** @deprecated Use ManagerPortalSettingsModal with initialTab="calendar". */
export function TourReminderSettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return <ManagerPortalSettingsModal open={open} onClose={onClose} initialTab="calendar" />;
}
