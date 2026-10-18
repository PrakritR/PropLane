"use client";

import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { usePortalNavigate } from "@/lib/portal-nav-client";

/**
 * The Escalations icon in the Communication header band: opens the escalations inbox, a sibling of
 * Active and Archived. /demo has no such page, so it draws nothing there (and nothing until the
 * browser check resolves, so it never flashes in and out).
 */
export function ManagerEscalationsAction({ commBase }: { commBase: string }) {
  const navigate = usePortalNavigate();
  const [demo, setDemo] = useState<boolean | null>(null);
  useEffect(() => {
    queueMicrotask(() => setDemo(isDemoModeActive()));
  }, []);
  if (demo !== false) return null;
  return (
    <PortalIconAction
      icon={TriangleAlert}
      label="Escalations"
      data-attr="communication-escalations"
      onClick={() => navigate(`${commBase}/escalations`)}
    />
  );
}
