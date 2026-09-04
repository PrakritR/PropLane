"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";

type WaiverCode = {
  id: string;
  code: string;
  label: string | null;
  status: "active" | "revoked";
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
};

type WaiverRedemption = {
  id: string;
  codeId: string;
  propertyId: string;
  residentEmail: string;
  applicationId: string | null;
  redeemedAt: string;
};

function usesLabel(code: WaiverCode): string {
  return code.maxUses == null ? `${code.usedCount} used` : `${code.usedCount} / ${code.maxUses} used`;
}

function expiryLabel(code: WaiverCode): string | null {
  if (!code.expiresAt) return null;
  const expired = Date.parse(code.expiresAt) <= Date.now();
  return `${expired ? "Expired" : "Expires"} ${new Date(code.expiresAt).toLocaleDateString()}`;
}

const DEMO_CODES: WaiverCode[] = [
  {
    id: "demo-1",
    code: "WELCOME50",
    label: "Referral promo",
    status: "active",
    maxUses: null,
    usedCount: 3,
    expiresAt: null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  },
];

export function ManagerApplicationFeeWaiverCodesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [codes, setCodes] = useState<WaiverCode[]>([]);
  const [redemptions, setRedemptions] = useState<WaiverRedemption[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [customCode, setCustomCode] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  const load = useCallback(async () => {
    if (demo) {
      setCodes(DEMO_CODES);
      setRedemptions([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/manager/application-fee-waivers", { credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as {
        codes?: WaiverCode[];
        redemptions?: WaiverRedemption[];
        error?: string;
      };
      if (!res.ok) {
        showToast(data.error ?? "Could not load waiver codes.");
        return;
      }
      setCodes(data.codes ?? []);
      setRedemptions(data.redemptions ?? []);
    } catch {
      showToast("Could not load waiver codes.");
    } finally {
      setLoading(false);
    }
  }, [demo, showToast]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function createCode() {
    if (demo) {
      setCodes((prev) => [
        {
          id: `demo-${Date.now()}`,
          code: customCode.trim().toUpperCase() || `DEMO${prev.length + 1}`,
          label: label.trim() || null,
          status: "active",
          maxUses: maxUses.trim() ? Number(maxUses) : null,
          usedCount: 0,
          expiresAt: expiresAt.trim() ? new Date(expiresAt).toISOString() : null,
          createdAt: new Date().toISOString(),
          revokedAt: null,
        },
        ...prev,
      ]);
      setLabel("");
      setCustomCode("");
      setMaxUses("");
      setExpiresAt("");
      showToast("Code created (demo).");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/manager/application-fee-waivers", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: customCode.trim() || undefined,
          label: label.trim() || undefined,
          maxUses: maxUses.trim() ? Number(maxUses) : null,
          expiresAt: expiresAt.trim() ? new Date(expiresAt).toISOString() : null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { code?: WaiverCode; error?: string };
      if (!res.ok) {
        showToast(data.error ?? "Could not create code.");
        return;
      }
      setLabel("");
      setCustomCode("");
      setMaxUses("");
      setExpiresAt("");
      showToast("Waiver code created.");
      await load();
    } catch {
      showToast("Could not create code.");
    } finally {
      setCreating(false);
    }
  }

  async function revokeCode(id: string) {
    if (demo) {
      setCodes((prev) => prev.map((c) => (c.id === id ? { ...c, status: "revoked", revokedAt: new Date().toISOString() } : c)));
      showToast("Code revoked (demo).");
      return;
    }
    setRevokingId(id);
    try {
      const res = await fetch(`/api/manager/application-fee-waivers/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke" }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        showToast(data.error ?? "Could not revoke code.");
        return;
      }
      showToast("Code revoked.");
      await load();
    } catch {
      showToast("Could not revoke code.");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <Modal open={open} title="Application fee waiver codes" onClose={onClose} assistantContext="Application fee waiver codes">
      <div className="space-y-4">
        <p className="text-xs text-muted">
          An applicant who enters a valid code pays no application fee — nothing is charged, not even $0. Codes are
          reusable until you set a use limit or expiry, and only work on your own listings.
        </p>

        <div className="space-y-2 rounded-xl border border-border bg-card px-4 py-3.5">
          <p className="text-sm font-semibold text-foreground">Create a code</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input
              value={customCode}
              onChange={(e) => setCustomCode(e.target.value)}
              placeholder="Code (leave blank to auto-generate)"
              data-attr="manager-waiver-code-input"
            />
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (optional, e.g. Referral promo)"
              data-attr="manager-waiver-code-label"
            />
            <Input
              type="number"
              min={1}
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              placeholder="Use limit (blank = unlimited)"
              data-attr="manager-waiver-code-max-uses"
            />
            <Input
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              placeholder="Expires (optional)"
              data-attr="manager-waiver-code-expires"
            />
          </div>
          <Button
            type="button"
            variant="primary"
            className="rounded-full px-4 text-[13px]"
            disabled={creating}
            data-attr="manager-waiver-code-create"
            onClick={() => createCode()}
          >
            {creating ? "Creating…" : "Create code"}
          </Button>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-semibold text-foreground">Your codes</p>
          {loading ? <p className="text-sm text-muted">Loading…</p> : null}
          {!loading && codes.length === 0 ? <p className="text-sm text-muted">No waiver codes yet.</p> : null}
          {codes.map((c) => {
            const codeRedemptions = redemptions.filter((r) => r.codeId === c.id);
            return (
              <div key={c.id} className="rounded-xl border border-border bg-card px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-mono text-sm font-bold tracking-tight text-foreground">{c.code}</span>
                    {c.label ? <span className="ml-2 text-xs text-muted">{c.label}</span> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs font-medium ${c.status === "active" ? "text-[var(--status-confirmed-fg)]" : "text-muted"}`}
                    >
                      {c.status === "active" ? "Active" : "Revoked"}
                    </span>
                    {c.status === "active" ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="rounded-full px-3 text-[12px]"
                        disabled={revokingId === c.id}
                        data-attr="manager-waiver-code-revoke"
                        onClick={() => revokeCode(c.id)}
                      >
                        {revokingId === c.id ? "Revoking…" : "Revoke"}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {usesLabel(c)}
                  {expiryLabel(c) ? ` · ${expiryLabel(c)}` : ""}
                </p>
                {codeRedemptions.length > 0 ? (
                  <div className="mt-2 space-y-1 border-t border-border pt-2">
                    {codeRedemptions.slice(0, 5).map((r) => (
                      <p key={r.id} className="text-xs text-muted">
                        Waived for {r.residentEmail} · {new Date(r.redeemedAt).toLocaleDateString()}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
