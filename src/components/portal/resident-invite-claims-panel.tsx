"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import {
  readManagerApplicationRows,
  replaceManagerApplicationRowInCache,
  upsertApplicationRowToServerAwait,
} from "@/lib/manager-applications-storage";

export type ResidentInviteClaimView = {
  id: string;
  claimantEmail: string;
  claimantName: string | null;
  propertyId: string | null;
  roomId: string | null;
  linkLabel: string | null;
  createdAt: string;
};

/**
 * People who opened a shareable resident invite link and said they live here.
 *
 * A claim grants NOTHING on its own — this screen is the grant. The manager
 * reads a self-asserted name and email and decides which resident record it
 * belongs to, because the address on the claim comes from an account the
 * claimant created moments ago and matching it automatically against
 * `resident_email` would hand whoever holds the link that person's tenancy.
 *
 * That is why "Approve" is disabled until a resident is picked: there is
 * deliberately no default selection, and no server-side fallback that guesses.
 */
export function ResidentInviteClaimsPanel({
  residentOptions,
  propertyLabelFor,
  onApproved,
  showToast,
}: {
  /** Resident records the manager can attach a claim to. */
  residentOptions: { id: string; label: string }[];
  propertyLabelFor: (propertyId: string | null) => string;
  onApproved?: () => void;
  showToast: (message: string) => void;
}) {
  const [claims, setClaims] = useState<ResidentInviteClaimView[] | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/pro/resident-claims?status=pending", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) {
        setClaims([]);
        return;
      }
      const body = (await res.json()) as { claims?: ResidentInviteClaimView[] };
      setClaims(body.claims ?? []);
    } catch {
      // A failed load leaves the section absent rather than showing a broken
      // shell — a claim the manager cannot see is not a claim they can act on
      // wrongly.
      setClaims([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = useCallback(
    async (claimId: string, status: "approved" | "rejected") => {
      setBusyId(claimId);
      try {
        const res = await fetch("/api/pro/resident-claims", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            claimId,
            status,
            linkedApplicationId: status === "approved" ? picked[claimId] : undefined,
          }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          setupLinkSent?: boolean;
        };
        if (!res.ok) {
          showToast(body.error ?? "Could not update that request.");
          return;
        }
        // Point the resident record at the address the claimant proved.
        //
        // This runs on the CLIENT on purpose. The manager's browser holds the
        // authoritative copy of these rows and mirrors it back to the server, so
        // the same write made server-side is silently reverted by the next sync
        // — the row's `updated_at` advances while the email snaps back. Writing
        // through the storage layer that owns the row makes the pairing stick.
        //
        // Without it the approval is decorative: the resident portal decides
        // what someone may see from `resident_email`, so a record still carrying
        // the old address leaves the confirmed resident locked out.
        const linkedId = picked[claimId];
        if (status === "approved" && linkedId) {
          const claim = claims?.find((c) => c.id === claimId);
          const row = readManagerApplicationRows().find((r) => r.id === linkedId);
          if (claim?.claimantEmail && row) {
            const paired = { ...row, email: claim.claimantEmail };
            replaceManagerApplicationRowInCache(paired);
            const saved = await upsertApplicationRowToServerAwait(paired);
            if (!saved.ok) {
              showToast(
                saved.error ??
                  "Confirmed, but we could not save their email onto that resident. Edit the resident to fix it.",
              );
              await load();
              return;
            }
          }
        }

        showToast(
          status !== "approved"
            ? "Request dismissed."
            : body.setupLinkSent
              ? "Resident confirmed — account setup link sent."
              : "Resident confirmed. Send them their account setup link from their profile.",
        );
        await load();
        if (status === "approved") onApproved?.();
      } finally {
        setBusyId(null);
      }
    },
    [claims, load, onApproved, picked, showToast],
  );

  if (!claims || claims.length === 0) return null;

  return (
    <section className="rounded-2xl border border-primary/40 bg-primary/[0.04] p-4" data-attr="resident-invite-claims">
      <h3 className="text-sm font-semibold text-foreground">
        Requests to join ({claims.length})
      </h3>
      <p className="mt-1 text-xs text-muted">
        These people opened your invite link and said they live at one of your properties. Confirm
        which resident each one is — nothing is linked until you do.
      </p>

      <ul className="mt-3 space-y-3">
        {claims.map((claim) => (
          <li key={claim.id} className="rounded-xl border border-border bg-background p-3">
            <p className="text-sm font-semibold text-foreground">
              {claim.claimantName?.trim() || claim.claimantEmail}
            </p>
            <p className="text-xs text-muted">{claim.claimantEmail}</p>
            <p className="mt-1 text-xs text-muted">
              Says they live at {propertyLabelFor(claim.propertyId)}
              {claim.roomId ? ` · room ${claim.roomId}` : ""}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Select
                aria-label={`Which resident is ${claim.claimantName?.trim() || claim.claimantEmail}?`}
                value={picked[claim.id] ?? ""}
                onChange={(e) => setPicked((prev) => ({ ...prev, [claim.id]: e.target.value }))}
                className="min-w-[14rem]"
              >
                <option value="">Which resident is this?</option>
                {residentOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                variant="primary"
                className="h-9 min-h-0 rounded-full px-4 text-[13px]"
                // No default selection and no server-side guess: approving
                // without naming the resident is the mismatch this whole flow
                // exists to prevent.
                disabled={!picked[claim.id] || busyId === claim.id}
                onClick={() => resolve(claim.id, "approved")}
                data-attr="resident-claim-approve"
              >
                Approve
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-9 min-h-0 rounded-full px-4 text-[13px]"
                disabled={busyId === claim.id}
                onClick={() => resolve(claim.id, "rejected")}
                data-attr="resident-claim-dismiss"
              >
                Dismiss
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
