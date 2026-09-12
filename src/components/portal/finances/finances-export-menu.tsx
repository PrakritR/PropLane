"use client";

import { Download } from "lucide-react";

import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export type FinancesExportItem = {
  id: string;
  label: string;
  href: string;
  dataAttr?: string;
};

/**
 * Finances' one export control, in the title row beside Filter. It replaced a
 * floating "1 selected · Export CSV" pill that appeared with nothing selected
 * and a row of "Export CSV / PDF / QuickBooks" buttons that changed shape per
 * tab: one menu, its rows the formats this tab can produce.
 */
export function FinancesExportMenu({ items }: { items: FinancesExportItem[] }) {
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PortalIconAction icon={Download} label="Export" data-attr="finances-export-menu" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        {items.map((item) => (
          <DropdownMenuItem key={item.id} asChild>
            <a href={item.href} data-attr={item.dataAttr}>
              <Download />
              {item.label}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
