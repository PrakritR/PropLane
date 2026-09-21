"use client";

import { createContext, useContext, type ReactNode } from "react";

export type PortalAssistantConfig = {
  endpoint: string;
  managerName: string | null;
  smsTest?: {
    active: boolean;
    loading: boolean;
    error: string | null;
    portal: "manager" | "resident";
    targets: Array<{
      listingId: string;
      managerUserId: string;
      title: string;
      address: string;
      stage?: "prospect" | "submitted" | "approved";
    }>;
    selectedTargetId: string;
    onSelectTarget: (listingId: string) => void;
    onToggle: () => void;
    onRetry: () => void;
  };
};

const PortalAssistantConfigContext = createContext<PortalAssistantConfig | null>(null);

export function PortalAssistantConfigProvider({
  endpoint,
  managerName,
  smsTest,
  children,
}: PortalAssistantConfig & { children: ReactNode }) {
  return (
    <PortalAssistantConfigContext.Provider value={{ endpoint, managerName, smsTest }}>
      {children}
    </PortalAssistantConfigContext.Provider>
  );
}

export function usePortalAssistantConfig(): PortalAssistantConfig | null {
  return useContext(PortalAssistantConfigContext);
}
