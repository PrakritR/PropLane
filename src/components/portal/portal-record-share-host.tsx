"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { PortalRecordShareModal } from "@/components/portal/portal-record-share-modal";

type RecordShareKind = "lease" | "application";

export type PortalRecordShareRequest = {
  kind: RecordShareKind;
  recordId: string;
  recordTitle?: string;
};

type PortalRecordShareHostValue = {
  openShare: (request: PortalRecordShareRequest) => void;
};

const PortalRecordShareHostContext = createContext<PortalRecordShareHostValue | null>(null);

/** Host lives outside the ⋯ menu so Share survives the menu close and is not frosted by it. */
export function PortalRecordShareHost({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<PortalRecordShareRequest | null>(null);
  const openShare = useCallback((next: PortalRecordShareRequest) => {
    setRequest(next);
  }, []);
  const value = useMemo(() => ({ openShare }), [openShare]);

  return (
    <PortalRecordShareHostContext.Provider value={value}>
      {children}
      <PortalRecordShareModal
        open={Boolean(request)}
        onClose={() => setRequest(null)}
        kind={request?.kind ?? "application"}
        recordId={request?.recordId ?? ""}
        recordTitle={request?.recordTitle}
      />
    </PortalRecordShareHostContext.Provider>
  );
}

export function usePortalRecordShareHost(): PortalRecordShareHostValue | null {
  return useContext(PortalRecordShareHostContext);
}
