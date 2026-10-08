"use client";

import { Eye } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmRows, PortalDialog } from "@/components/portal/portal-dialog";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { clearPortalBrowserCache } from "@/lib/auth/clear-portal-browser-cache";
import {
  normalizeViewAsReason,
  VIEW_AS_REASON_MAX,
  VIEW_AS_TTL_SECONDS,
  type ViewAsPortal,
} from "@/lib/auth/view-as-token";

const PORTAL_LABEL: Record<ViewAsPortal, string> = {
  manager: "Manager portal",
  resident: "Resident portal",
  vendor: "Vendor portal",
};

type Eligibility = { canViewAs: boolean; portals: ViewAsPortal[] };

/**
 * Which portals (if any) this operator may open on this account. The server
 * decides (`GET /api/admin/preview`): not allowlisted, not an admin, an admin
 * target, a disabled account and a role the account does not hold all answer
 * "no portals", and the button simply never appears.
 */
function useViewAsEligibility(targetUserId: string): Eligibility | null {
  const [state, setState] = useState<Eligibility | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/preview?targetUserId=${encodeURIComponent(targetUserId)}`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Eligibility | null) => {
        if (!cancelled) setState(data && data.canViewAs ? { canViewAs: true, portals: data.portals ?? [] } : { canViewAs: false, portals: [] });
      })
      .catch(() => {
        if (!cancelled) setState({ canViewAs: false, portals: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [targetUserId]);
  return state;
}

/**
 * The account record's primary "View as" action and its dialog. Rendered only
 * for an allowlisted operator and only when the account holds a portal.
 */
export function AdminViewAsAction({
  targetUserId,
  targetName,
  preferredPortal,
}: {
  targetUserId: string;
  targetName: string;
  preferredPortal?: ViewAsPortal;
}) {
  const eligibility = useViewAsEligibility(targetUserId);
  const [open, setOpen] = useState(false);
  if (!eligibility?.canViewAs || eligibility.portals.length === 0) return null;
  return (
    <>
      <PortalIconAction
        ring
        ringPrimary
        icon={Eye}
        label="View as"
        data-attr="admin-account-view-as"
        onClick={() => setOpen(true)}
      />
      {open ? (
        <AdminViewAsDialog
          targetUserId={targetUserId}
          targetName={targetName}
          portals={eligibility.portals}
          initialPortal={preferredPortal}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function AdminViewAsDialog({
  targetUserId,
  targetName,
  portals,
  initialPortal,
  onClose,
}: {
  targetUserId: string;
  targetName: string;
  portals: ViewAsPortal[];
  initialPortal?: ViewAsPortal;
  onClose: () => void;
}) {
  const [portal, setPortal] = useState<ViewAsPortal>(
    initialPortal && portals.includes(initialPortal) ? initialPortal : portals[0]!,
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonOk = normalizeViewAsReason(reason) !== null;

  const start = async () => {
    if (!reasonOk) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/preview", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId, portal, reason }),
      });
      const data = (await res.json().catch(() => ({}))) as { redirectTo?: string; error?: string };
      if (!res.ok || !data.redirectTo) {
        setError(data.error || "Could not start viewing.");
        return;
      }
      // Whatever this browser cached for the operator's own portal must not be
      // shown as this account's data (or the reverse when the session ends).
      clearPortalBrowserCache();
      window.location.assign(data.redirectTo);
    } catch {
      setError("Could not start viewing.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PortalDialog
      open
      onClose={onClose}
      title={`View as ${targetName}`}
      dataAttr="admin-view-as-dialog"
      primaryAction={{
        label: "Start viewing",
        onClick: start,
        disabled: !reasonOk || busy,
        loading: busy,
        dataAttr: "admin-view-as-start",
      }}
    >
      <div className="space-y-4">
        <FieldSingleSelect
          label="Portal"
          value={portal}
          onChange={(next) => setPortal(next as ViewAsPortal)}
          options={portals.map((p) => ({ value: p, label: PORTAL_LABEL[p] }))}
          dataAttr="admin-view-as-portal"
        />
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-foreground">Reason</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, VIEW_AS_REASON_MAX))}
            rows={3}
            required
            className="w-full rounded-2xl border border-border bg-card px-3.5 py-2 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-primary/25"
            data-attr="admin-view-as-reason"
          />
        </label>
        <ConfirmRows rows={[{ label: "Length", value: `${VIEW_AS_TTL_SECONDS / 60} minutes` }]} />
        <p className="text-sm text-foreground" data-attr="admin-view-as-fact">
          Read-only. Every view is logged on this account&rsquo;s audit trail.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </PortalDialog>
  );
}
