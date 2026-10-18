"use client";

import { useEffect, useState } from "react";
import { sharedGet } from "@/lib/shared-get-cache";

/** Settings on the same page share one bounded read of the rollout flag. */
export function useSharedPhoneAuth(demo = false): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (demo) return;
    let active = true;
    void sharedGet("/api/auth/phone").then((result) => {
      if (!active || !result.ok) return;
      const status = result.data as { enabled?: boolean } | null;
      setEnabled(status?.enabled === true);
    });
    return () => { active = false; };
  }, [demo]);
  return !demo && enabled;
}
