"use client";

import { createContext, useContext, type ReactNode } from "react";

/** Set by the /portal layout while a PropLane Service workspace is open (service mode). `isAdmin` = a platform admin. */
export type ServiceModeValue = { active: boolean; isAdmin: boolean };

const ServiceModeContext = createContext<ServiceModeValue>({ active: false, isAdmin: false });

export function ServiceModeProvider({ value, children }: { value: ServiceModeValue; children: ReactNode }) {
  return <ServiceModeContext.Provider value={value}>{children}</ServiceModeContext.Provider>;
}

export function useServiceMode(): ServiceModeValue {
  return useContext(ServiceModeContext);
}
