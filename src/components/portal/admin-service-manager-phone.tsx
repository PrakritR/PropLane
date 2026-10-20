"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { formatUsPhone } from "@/components/portal/admin-service-vendors-list";
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";

const API = "/api/admin/service-manager";
const TIMEOUT_MS = 25_000;

type View = { configured: boolean; phone: string | null; verified: boolean };

async function call(body?: Record<string, unknown>): Promise<{ ok: boolean; json: Partial<View> & { error?: string } }> {
  const res = await fetchWithTimeout(
    API,
    body
      ? { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : { credentials: "include" },
    TIMEOUT_MS,
  );
  return { ok: res.ok, json: (await res.json().catch(() => ({}))) as Partial<View> & { error?: string } };
}

/**
 * Admin Service settings > Manager phone. The one phone that acts as the service manager: PropLane Service alerts are
 * texted to it, and a text from it to the PropLane line is the manager of every service workspace. Change it with a
 * six-digit code sent to the new number.
 */
export function AdminServiceManagerPhone({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { showToast } = useAppUi();
  const [view, setView] = useState<View | null>(null);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setCode("");
    setCodeSent(false);
    let cancelled = false;
    void (async () => {
      try {
        const { ok, json } = await call();
        if (cancelled) return;
        if (!ok) {
          setError(json.error ?? "Could not load the manager phone.");
          return;
        }
        setView({ configured: json.configured !== false, phone: json.phone ?? null, verified: json.verified === true });
        setPhone(json.phone ? formatUsPhone(json.phone) : "");
      } catch {
        if (!cancelled) setError("Could not load the manager phone.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const run = async (body: Record<string, unknown>, onOk: (json: Partial<View>) => void, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      const { ok, json } = await call(body);
      if (!ok) {
        setError(json.error ?? failure);
        return;
      }
      onOk(json);
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const sendCode = () =>
    run({ action: "send-code", phone }, () => { setCodeSent(true); showToast("Code sent."); }, "Could not send a code.");
  const verify = () =>
    run({ action: "verify", phone, code }, (json) => {
      setView({ configured: true, phone: json.phone ?? null, verified: json.verified === true });
      setCode("");
      setCodeSent(false);
      showToast("Manager phone verified.");
    }, "Could not verify the code.");
  const clear = () =>
    run({ action: "clear" }, () => { setView({ configured: true, phone: null, verified: false }); setPhone(""); showToast("Manager phone removed."); }, "Could not remove the phone.");

  const changed = !view?.phone || formatUsPhone(view.phone) !== phone.trim();

  return (
    <Modal
      open={open}
      title="Manager phone"
      onClose={onClose}
      contextPanel={null}
      preview={null}
      dataAttr="admin-service-manager-phone-modal"
      footer={
        <ModalFooter>
          {codeSent ? (
            <Button type="button" disabled={busy || code.trim().length < 6} data-attr="admin-service-manager-verify" onClick={() => void verify()}>
              Verify
            </Button>
          ) : (
            <Button type="button" disabled={busy || !phone.trim() || (!changed && view?.verified === true)} data-attr="admin-service-manager-send-code" onClick={() => void sendCode()}>
              Send code
            </Button>
          )}
        </ModalFooter>
      }
    >
      <div className="space-y-3">
        <label className="block text-[13px] font-semibold text-foreground">
          <span className="mb-1 block">Phone</span>
          <Input value={phone} onChange={(e) => { setPhone(e.target.value); setCodeSent(false); }} inputMode="tel" maxLength={24} data-attr="admin-service-manager-phone" />
        </label>
        {view?.phone ? (
          <p className="text-[13px] text-foreground" data-attr="admin-service-manager-status">
            {view.verified ? "Verified" : "Not verified"}
          </p>
        ) : null}
        {codeSent ? (
          <label className="block text-[13px] font-semibold text-foreground">
            <span className="mb-1 block">Code</span>
            <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} data-attr="admin-service-manager-code" />
          </label>
        ) : null}
        {view?.phone ? (
          <Button type="button" variant="danger" disabled={busy} data-attr="admin-service-manager-clear" onClick={() => void clear()}>
            Remove
          </Button>
        ) : null}
      </div>
      {error ? <p className="mt-2 text-[13px] text-[var(--status-overdue-fg)]" role="alert">{error}</p> : null}
    </Modal>
  );
}
