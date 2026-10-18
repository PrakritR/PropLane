"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Both footers arrive as server-rendered children, not a client footer bundle. */
export function PublicFooterRoute({ home, children }: { home: ReactNode; children: ReactNode }) {
  return usePathname() === "/" ? home : children;
}
