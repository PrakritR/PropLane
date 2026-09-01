"use client";

import { useSyncExternalStore } from "react";
import {
  isScreeningTestModeActive,
  subscribeScreeningTestMode,
} from "@/lib/screening/screening-test-mode";

export function useScreeningTestMode(): boolean {
  return useSyncExternalStore(subscribeScreeningTestMode, isScreeningTestModeActive, () => false);
}
