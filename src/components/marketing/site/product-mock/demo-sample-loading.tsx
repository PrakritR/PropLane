"use client";

import { useContext } from "react";
import { createPortal } from "react-dom";
import { DemoPopupHostContext } from "./demo-popup-host";

/** A visible, motion-free state while a fixture chunk arrives. */
export function DemoSampleLoading() {
  return <div role="status" className="flex min-h-24 w-full min-w-0 items-center justify-center p-4 text-sm text-muted">Loading sample…</div>;
}

/** Dialogs load above their existing panel, within the preview's own bounds. */
export function DemoPopupLoading() {
  const host = useContext(DemoPopupHostContext);
  const status = <div className="pointer-events-none absolute inset-x-4 top-4 z-40 rounded-lg border border-border bg-card shadow-sm"><DemoSampleLoading /></div>;
  return host ? createPortal(status, host) : status;
}
