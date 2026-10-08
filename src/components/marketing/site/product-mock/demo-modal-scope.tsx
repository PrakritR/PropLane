"use client";

import { useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PortalContainerProvider } from "@/components/ui/portal-container-context";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { DemoPopupHostContext } from "@/components/marketing/site/product-mock/demo-popup-host";

/* ───────────────────────────── the scope every Modal draws in ───────────────────────────── */

/**
 * Where the real `Modal`s draw. The demo window provides a host element (`DemoPopupHostContext`); this layer lives in
 * it, fills the window, and is the portal container for Radix and the containing block for the modal's
 * `position: fixed` stack (a transform makes it one), so a modal covers the demo window and never the page behind.
 * `AppUiProvider` is the toast host the real modals call (`useAppUi`).
 */
export function DemoModalScope({ children }: { children: ReactNode }) {
  const host = useContext(DemoPopupHostContext);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const node = (
    <div
      ref={setLayer}
      data-demo-popup=""
      data-demo-modal-scope=""
      className="pointer-events-auto absolute inset-0 z-[40] overflow-hidden"
      style={{ transform: "translateZ(0)", containerType: "size" }}
    >
      {/* The real panels size themselves to the browser (`100dvh`); inside the demo window they size to the window. */}
      <style>{`@layer utilities { [data-demo-modal-scope] [data-slot="modal-radix-dialog"] { max-height: calc(100cqh - 24px) !important; } }`}</style>
      {layer ? (
        <PortalContainerProvider container={layer}>
          <AppUiProvider>{children}</AppUiProvider>
        </PortalContainerProvider>
      ) : null}
    </div>
  );
  return host ? createPortal(node, host) : node;
}
