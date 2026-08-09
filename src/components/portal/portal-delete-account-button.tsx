"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import posthog from "posthog-js";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { PortalKind } from "@/lib/portal-types";

type DeleteCopy = {
  title: string;
  lead: string;
  body: string;
};

function deleteCopyForPortal(portal: PortalKind): DeleteCopy {
  switch (portal) {
    case "resident":
      return {
        title: "Delete resident account",
        lead: "This permanently removes your resident portal access. This can't be undone.",
        body:
          "Deleting removes your resident profile, applications, lease paperwork, payments, messages, maintenance requests, and documents tied to this resident portal. Your property manager or vendor account on the same login is not affected.",
      };
    case "vendor":
      return {
        title: "Delete vendor account",
        lead: "This permanently removes your vendor portal access. This can't be undone.",
        body:
          "Deleting removes your vendor profile, bids, invoices, and work-order participation tied to this vendor portal. Your manager or resident account on the same login is not affected.",
      };
    case "admin":
      return {
        title: "Delete admin access",
        lead: "This permanently removes your admin portal access. This can't be undone.",
        body:
          "Deleting removes your admin role on PropLane. Your manager, resident, or vendor account on the same login is not affected.",
      };
    case "pro":
    case "manager":
    default:
      return {
        title: "Delete property account",
        lead: "This permanently removes your property manager portal access. This can't be undone.",
        body:
          "Deleting removes your properties, listings, applications, leases, payments, messages, documents, and co-manager links tied to this property portal. Your resident or vendor account on the same login is not affected.",
      };
  }
}

/**
 * Self-service portal account deletion (App Store Guideline 5.1.1(v)). Reachable
 * on web AND inside the native iOS/Android shell. A user can only ever delete
 * their OWN account for the portal they are signed into — the route resolves the
 * target from the session, never the client. Two-step: red entry → explicit
 * confirmation modal → portal-scoped delete → signed out or redirected.
 */
export function PortalDeleteAccountButton({
  className,
  portalKind,
}: {
  className?: string;
  portalKind: PortalKind;
}) {
  const router = useRouter();
  const { showToast } = useAppUi();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const copy = useMemo(() => deleteCopyForPortal(portalKind), [portalKind]);

  const deleteAccount = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/auth/delete-my-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ confirm: "DELETE", portal: portalKind }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        signedOut?: boolean;
        redirectTo?: string;
      };
      if (!res.ok) {
        showToast(body.error || "Couldn't delete your account. Please try again.");
        setBusy(false);
        return;
      }

      try {
        posthog.reset();
      } catch {
        /* analytics reset is best-effort */
      }

      if (body.signedOut) {
        try {
          const supabase = createSupabaseBrowserClient();
          await supabase.auth.signOut({ scope: "local" });
        } catch {
          /* server route already cleared the session when signedOut */
        }
      }

      const destination = body.redirectTo?.trim() || "/auth/sign-in?deleted=1";
      router.push(destination);
      router.refresh();
    } catch {
      showToast("Couldn't delete your account. Please try again.");
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={className}
        data-attr="portal-delete-account"
        onClick={() => setOpen(true)}
      >
        Delete account
      </button>

      <Modal
        open={open}
        title={copy.title}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        footer={
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button
              type="button"
              variant="danger"
              disabled={busy}
              onClick={() => deleteAccount()}
              data-attr="portal-delete-account-confirm"
            >
              {busy ? "Deleting…" : "Yes, permanently delete"}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm text-foreground">
          <p className="font-semibold text-danger">{copy.lead}</p>
          <p>{copy.body}</p>
          <p className="text-muted">
            Records required for legal or financial compliance (for example, payment history held by
            our payment processor, Stripe) may be retained as required by law.
          </p>
        </div>
      </Modal>
    </>
  );
}
