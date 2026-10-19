"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Route-level entrance: remount on pathname so CSS animation runs once per navigation. */
export function PublicMainTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className={pathname === "/" ? "flex-1" : "animate-page-enter flex-1"}>
      {children}
    </div>
  );
}
