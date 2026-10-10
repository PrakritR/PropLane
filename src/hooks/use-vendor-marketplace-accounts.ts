"use client";

import { useCallback, useEffect, useState } from "react";

import { useWorkspaces } from "@/components/portal/workspace-provider";
import { invalidateSharedGets, sharedGet } from "@/lib/shared-get-cache";
import type { VendorMarketplaceAccountRow, VendorMarketplaceId } from "@/lib/vendor-marketplaces/registry";

const ROUTE = "/api/manager/vendor-marketplace-accounts";

type Payload = { workspaceId: string; canManage: boolean; accounts: VendorMarketplaceAccountRow[] };

function isPayload(data: unknown): data is Payload {
  const d = data as Partial<Payload> | null;
  return Boolean(d && Array.isArray(d.accounts));
}

/** The accounts the manager added at outside marketplaces, in the active workspace. One shared read per URL. */
export function useVendorMarketplaceAccounts() {
  const workspaceId = useWorkspaces()?.active?.id;
  const [payload, setPayload] = useState<Payload | null>(null);
  const url = workspaceId ? `${ROUTE}?workspaceId=${encodeURIComponent(workspaceId)}` : ROUTE;

  useEffect(() => {
    let cancelled = false;
    void sharedGet(url).then((res) => {
      if (!cancelled && res.ok && isPayload(res.data)) setPayload(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const refresh = useCallback(async () => {
    invalidateSharedGets(ROUTE);
    const res = await sharedGet(url, { force: true });
    if (res.ok && isPayload(res.data)) setPayload(res.data);
  }, [url]);

  const accountFor = useCallback(
    (marketplace: VendorMarketplaceId) => payload?.accounts.find((a) => a.marketplace === marketplace) ?? null,
    [payload],
  );

  return { accounts: payload?.accounts ?? [], accountFor, canManage: payload?.canManage ?? false, workspaceId, refresh };
}

async function write(method: "POST" | "DELETE", body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(ROUTE, {
      method,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: json.error ?? "Could not save." };
  } catch {
    return { ok: false, error: "Could not save." };
  }
}

export const saveVendorMarketplaceAccount = (body: { marketplace: VendorMarketplaceId; accountLabel: string; profileUrl?: string; workspaceId?: string }) =>
  write("POST", body);

export const removeVendorMarketplaceAccount = (body: { marketplace: VendorMarketplaceId; workspaceId?: string }) => write("DELETE", body);
