"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { PublicTextingConfig } from "@/lib/marketing/public-texting";

type PublicTextingSnapshot = PublicTextingConfig;
const PublicTextingContext = createContext<PublicTextingSnapshot>({
  phone: null,
  smsHref: null,
});

/** The public layout supplies its server snapshot; client pages never fetch another copy. */
export function PublicTextingProvider({
  value,
  children,
}: {
  value: PublicTextingSnapshot;
  children: ReactNode;
}) {
  return (
    <PublicTextingContext.Provider value={value}>
      {children}
    </PublicTextingContext.Provider>
  );
}

export function usePublicTexting(): PublicTextingSnapshot {
  return useContext(PublicTextingContext);
}
