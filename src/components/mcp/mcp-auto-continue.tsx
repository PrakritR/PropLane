"use client";

import { useEffect } from "react";

const CONTINUE_DELAY_MS = 1500;

/** Sends the browser on to the client's callback after the success state has been seen. */
export function McpAutoContinue({ destination }: { destination: string }) {
  useEffect(() => {
    const timer = window.setTimeout(() => window.location.replace(destination), CONTINUE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [destination]);
  return null;
}
