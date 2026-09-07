"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { PasswordInput } from "@/components/ui/password-input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { downloadOrShareFile } from "@/lib/native/download-or-share";
import { EXPORT_FILE_MIME, EXPORT_PASSWORD_MIN_LENGTH, validateExportPassword } from "@/lib/account-export/export-password";

const FALLBACK_FILE_NAME = "proplane-export.proplane";

/** `attachment; filename="proplane-export-2026-09-07.proplane"` → the file name. */
export function fileNameFromContentDisposition(header: string | null): string {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header ?? "");
  const name = match?.[1]?.trim();
  return name && !name.includes("/") && !name.includes("\\") ? name : FALLBACK_FILE_NAME;
}

/**
 * "Export my data" on Settings → Account (PRP-324). The manager picks a password, the
 * server answers with one encrypted `.proplane` file, and the download goes through
 * `downloadOrShareFile` so the Capacitor shell gets the system share sheet instead of a
 * synthetic anchor click WKWebView ignores. The password is sent once, over the same
 * session cookie as every other portal write, and is never stored client-side.
 */
export function PortalDataExportButton({ className }: { className?: string }) {
  const { showToast } = useAppUi();
  const passwordId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPassword("");
    setConfirm("");
    setError(null);
  };

  const close = () => {
    if (busy) return;
    setOpen(false);
    reset();
  };

  const exportData = async () => {
    if (busy) return;
    const invalid = validateExportPassword(password);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/portal/data-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error || "Couldn't build your export. Please try again.");
        return;
      }
      const content = await res.arrayBuffer();
      const fileName = fileNameFromContentDisposition(res.headers.get("Content-Disposition"));
      const outcome = await downloadOrShareFile({
        fileName,
        mimeType: res.headers.get("Content-Type") || EXPORT_FILE_MIME,
        content,
        title: "PropLane data export",
      });
      if (outcome !== "share-cancelled") {
        showToast("Your export is ready. Keep the password — it's the only way to open the file.");
      }
      setOpen(false);
      reset();
    } catch {
      setError("Couldn't build your export. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className={className} data-attr="portal-data-export" onClick={() => setOpen(true)}>
        Export my data
      </button>

      <Modal
        open={open}
        title="Export my data"
        onClose={close}
        footer={
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button type="button" disabled={busy} onClick={() => exportData()} data-attr="portal-data-export-confirm">
              {busy ? "Preparing export…" : "Download encrypted export"}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              Cancel
            </Button>
          </div>
        }
      >
        <div className="space-y-4 text-sm text-foreground">
          <p>
            You&apos;ll get one file with everything your property account owns: properties and
            listings, applications, leases, charges and ledger history, services, messages,
            document records, tasks and tours, plus your settings.
          </p>
          <p className="text-muted">
            Identity numbers (Social Security numbers, dates of birth, ID and license numbers) and
            payment details (card and bank numbers) are never included. Uploaded files are listed by
            name but not bundled.
          </p>
          <p className="text-muted">
            The file is encrypted with the password you choose below. PropLane doesn&apos;t keep a
            copy of it, so this password is the only way to open the file — store it somewhere safe.
          </p>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor={passwordId} className="block text-xs font-medium text-foreground">
                Export password (at least {EXPORT_PASSWORD_MIN_LENGTH} characters)
              </label>
              <PasswordInput
                id={passwordId}
                autoComplete="new-password"
                value={password}
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${passwordId}-confirm`} className="block text-xs font-medium text-foreground">
                Confirm password
              </label>
              <PasswordInput
                id={`${passwordId}-confirm`}
                autoComplete="new-password"
                value={confirm}
                disabled={busy}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </div>
            {error ? (
              <p className="text-xs font-medium text-danger" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      </Modal>
    </>
  );
}
