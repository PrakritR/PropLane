"use client";

import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import type { ManagerServiceRowMenuItem } from "@/lib/manager-service-row-menu";

export function ServiceListRowMenu({
  title,
  items,
  onAction,
}: {
  title: string;
  items: ManagerServiceRowMenuItem[];
  onAction: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <RowActionsMenu
      label={title}
      items={items.map((item) => ({
        id: item.id,
        label: item.label,
        danger: item.danger,
        onSelect: () => onAction(item.id),
      }))}
    />
  );
}
