"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Keep bearer-capability pages free of global assistant and marketing chrome. */
export function QuotePageBoundary({ children, quoteChildren = null }: { children: ReactNode; quoteChildren?: ReactNode }) {
  return usePathname() === "/vendor-quote" ? quoteChildren : children;
}
