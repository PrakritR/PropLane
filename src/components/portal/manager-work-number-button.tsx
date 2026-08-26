"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import { PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import {
  formatManagerMessagingPhone,
  MANAGER_MESSAGING_SETTINGS_HREF,
  type ManagerMessagingNumberStatus,
} from "@/lib/sms/manager-messaging-number";

/** Copy-only work number popup for manager Communication → SMS. */
export function ManagerWorkNumberButton({ className }: { className?: string }) {
  const { showToast } = useAppUi();
  const [workNumber, setWorkNumber] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
  const [statusError, setStatusError] = useState(false);
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [canSend, setCanSend] = useState(false);
  const [workspaceRole, setWorkspaceRole] =
    useState<ManagerMessagingNumberStatus["workspaceRole"]>("primary");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    setResolved(false);
    setStatusError(false);
    void fetch("/api/manager/messaging-number", {
      credentials: "include",
      cache: "no-store",
    })
      .then((res) => {
        if (!res.ok) throw new Error("Messaging status request failed.");
        return res.json();
      })
      .then((body) => {
        if (!active) return;
        if (body) {
          const payload = body as ManagerMessagingNumberStatus;
          setWorkNumber(payload.number?.phoneNumber ?? null);
          setCanSend(payload.canSend === true);
          setWorkspaceRole(
            payload.workspaceRole === "co_manager" ? "co_manager" : "primary",
          );
        }
        setResolved(true);
      })
      .catch(() => {
        if (active) {
          setStatusError(true);
          setResolved(true);
        }
      });
    return () => {
      active = false;
    };
  }, [statusAttempt]);

  const copyWorkNumber = useCallback(async () => {
    const num = workNumber?.trim();
    if (!num) return;
    const ok = await copyTextToClipboard(num);
    showToast(ok ? "Work number copied." : "Could not copy work number.");
  }, [showToast, workNumber]);

  return (
    <>
      {statusError ? (
        <div className="flex min-w-0 items-center gap-2" role="alert" aria-live="polite">
          <span className="sr-only">Messaging status unavailable.</span>
          <span className="hidden text-sm text-muted sm:inline" aria-hidden="true">
            Messaging status unavailable.
          </span>
          <Button
            type="button"
            variant="outline"
            className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN} ${className ?? ""}`.trim()}
            data-attr="messaging-status-retry"
            aria-label="Retry messaging status"
            title="Messaging status unavailable. Tap to retry."
            onClick={() => setStatusAttempt((attempt) => attempt + 1)}
          >
            Retry
          </Button>
        </div>
      ) : resolved && !workNumber ? (
        <Button
          asChild
          variant="outline"
          className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN} ${className ?? ""}`.trim()}
          data-attr="messaging-open-settings"
        >
          <Link
            href={MANAGER_MESSAGING_SETTINGS_HREF}
            aria-label={
              workspaceRole === "co_manager" ? "View messaging" : "Set up messaging"
            }
          >
            <span className="sm:hidden" aria-hidden="true">
              Messaging
            </span>
            <span className="hidden sm:inline">
              {workspaceRole === "co_manager"
                ? "View messaging"
                : "Set up messaging"}
            </span>
          </Link>
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN} ${className ?? ""}`.trim()}
          disabled={!resolved}
          onClick={() => setOpen(true)}
          data-attr="messaging-view-number"
          aria-label="View number"
        >
          <span className="sm:hidden" aria-hidden="true">
            Number
          </span>
          <span className="hidden sm:inline">View number</span>
        </Button>
      )}
      <Modal
        open={open}
        title="Work number"
        onClose={() => setOpen(false)}
        footer={
          <ModalFooter>
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              disabled={!workNumber}
              onClick={() => copyWorkNumber()}
            >
              Copy number
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            This number is assigned to your manager account and cannot be edited
            here.
          </p>
          <p className="rounded-xl border border-border bg-accent/25 px-3 py-2 text-base font-semibold text-foreground">
            {formatManagerMessagingPhone(workNumber)}
          </p>
          {!canSend ? (
            <p className="text-sm text-muted">
              Messaging approval is still in progress.
            </p>
          ) : null}
          <Link
            href={MANAGER_MESSAGING_SETTINGS_HREF}
            className="inline-flex min-h-10 items-center text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
            data-attr="messaging-manage-settings"
            onClick={() => setOpen(false)}
          >
            Manage messaging settings
          </Link>
        </div>
      </Modal>
    </>
  );
}
