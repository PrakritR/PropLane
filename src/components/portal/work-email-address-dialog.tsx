"use client";

/**
 * Change a workspace's work-email address: one field for the local part, the domain fixed beside it, live
 * availability from `check_address`, Save through `set_address`. Used by the Communication "Work email" card for the
 * owner and for staff of a PropLane-managed workspace; the server decides who may (`canEditAddress`).
 */
import { useEffect, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import type { ManagerAssistantEmailStatus } from "@/lib/manager-assistant-email/manager-assistant-email-status";
import type { MailboxLocalCheckResult } from "@/lib/manager-assistant-email/manager-assistant-email.server";
import { writeThroughFetch } from "@/lib/shared-get-cache";

const ENDPOINT = "/api/manager/assistant-email";
const CHECK_DEBOUNCE_MS = 400;

function availabilityLabel(check: MailboxLocalCheckResult | null, checking: boolean, unchanged: boolean): string {
  if (checking) return "Checking…";
  if (unchanged || !check) return "Current address";
  if (check.ok) return check.state === "current" ? "Current address" : "Available";
  if (check.state === "reserved") return "Reserved";
  if (check.state === "taken") return "Taken";
  return check.message;
}

export function WorkEmailAddressDialog({
  open,
  onClose,
  workspaceId,
  address,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** The workspace the card is showing; the server re-validates it, never trusts it as a grant. */
  workspaceId: string | null;
  /** The current full address, `local@domain`. */
  address: string;
  onSaved: (status: ManagerAssistantEmailStatus) => void;
}) {
  const { showToast } = useAppUi();
  const [currentLocal, domain] = address.split("@");
  const [local, setLocal] = useState(currentLocal ?? "");
  const [check, setCheck] = useState<MailboxLocalCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLocal(currentLocal ?? "");
    setCheck(null);
    setError(null);
  }, [open, currentLocal]);

  const trimmed = local.trim().toLowerCase();
  const unchanged = trimmed === (currentLocal ?? "");

  useEffect(() => {
    if (!open || !trimmed || unchanged) {
      setCheck(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    const controller = new AbortController();
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "check_address", local: trimmed, ...(workspaceId ? { workspaceId } : {}) }),
          signal: controller.signal,
        });
        const body = (await res.json().catch(() => null)) as MailboxLocalCheckResult | { error?: string } | null;
        if (body && "ok" in body) setCheck(body);
        else setCheck({ ok: false, state: "invalid", message: (body as { error?: string } | null)?.error ?? "Could not check that address." });
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setCheck({ ok: false, state: "invalid", message: "Could not check that address." });
      } finally {
        if (!controller.signal.aborted) setChecking(false);
      }
    }, CHECK_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [open, trimmed, unchanged, workspaceId]);

  const canSave = !saving && !checking && !unchanged && check !== null && check.ok && check.state === "available";

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await writeThroughFetch(
        ENDPOINT,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "set_address", local: trimmed, ...(workspaceId ? { workspaceId } : {}) }),
        },
        { invalidatePrefix: ENDPOINT },
      );
      const body = (await res.json().catch(() => ({}))) as ManagerAssistantEmailStatus & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not change the work email.");
      onSaved(body);
      showToast(`Work email changed to ${trimmed}@${domain}.`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the work email.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Work email"
      onClose={() => {
        if (!saving) onClose();
      }}
      contextPanel={null}
      preview={null}
      dataAttr="work-email-address-dialog"
      footer={
        <ModalFooter>
          <Button disabled={!canSave} loading={saving} onClick={() => save()} data-attr="work-email-address-save">
            Save
          </Button>
        </ModalFooter>
      }
    >
      <label className="block text-xs uppercase text-muted" htmlFor="work-email-address-local">
        Address
      </label>
      <div className="mt-2 flex items-center gap-2">
        <Input
          id="work-email-address-local"
          data-attr="work-email-address-local"
          value={local}
          onChange={(event) => setLocal(event.target.value.toLowerCase())}
          disabled={saving}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          maxLength={32}
          className="min-w-0 flex-1 font-semibold"
        />
        <span className="shrink-0 font-semibold text-muted">@{domain}</span>
      </div>
      <p className="mt-2 text-sm font-medium text-foreground" role="status" data-attr="work-email-address-availability">
        {availabilityLabel(check, checking, unchanged)}
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
