"use client";

import { useCallback, useEffect, useState } from "react";
import { MessagesSquare, Plus, Trash2 } from "lucide-react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { POPUP_FIELD_LABEL_CLASS } from "@/components/portal/popup-phone-styles";
import { Input } from "@/components/ui/input";
import type { SmsGroupMemberView } from "@/lib/house-sms-group/model";

type GroupView = {
  exists: boolean;
  status: "none" | "pending" | "active";
  maskedLine: string | null;
  members: SmsGroupMemberView[];
  phonesNeeded: number;
  message?: string | null;
};

const EMPTY: GroupView = { exists: false, status: "none", maskedLine: null, members: [], phonesNeeded: 2 };

async function call(method: "GET" | "POST", propertyId: string, body?: Record<string, unknown>): Promise<{ ok: boolean; view: GroupView; error?: string }> {
  try {
    const response = await fetch(
      method === "GET" ? `/api/portal/house-sms-group?propertyId=${encodeURIComponent(propertyId)}` : "/api/portal/house-sms-group",
      method === "GET"
        ? { cache: "no-store" }
        : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ propertyId, ...body }) },
    );
    const json = (await response.json().catch(() => ({}))) as Partial<GroupView> & { error?: string; ok?: boolean; message?: string | null };
    const view: GroupView = {
      exists: json.exists === true,
      status: json.status ?? "none",
      maskedLine: json.maskedLine ?? null,
      members: Array.isArray(json.members) ? json.members : [],
      phonesNeeded: typeof json.phonesNeeded === "number" ? json.phonesNeeded : 2,
      message: json.message ?? null,
    };
    if (!response.ok && response.status !== 409) return { ok: false, view, error: json.error ?? "Something went wrong." };
    return { ok: response.ok, view, error: json.message ?? json.error };
  } catch {
    return { ok: false, view: EMPTY, error: "Could not reach PropLane. Try again." };
  }
}

/**
 * "Text group" in a house chat's thread header: the SMS door of the same chat. Lists who is in the group
 * (first name, room, phone as its last four), adds you or another phone, removes a member. Members that
 * are residents come from occupancy on their own; this screen only manages the staff phones and removals.
 */
export function HouseSmsGroupAction({ propertyId, onChanged }: { propertyId: string; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<GroupView>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [agreed, setAgreed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await call("GET", propertyId);
    setView(result.view);
    setError(result.ok ? "" : (result.error ?? ""));
    setLoading(false);
  }, [propertyId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    const result = await call("POST", propertyId, body);
    setView(result.view);
    if (!result.ok && result.error) setError(result.error);
    else if (result.view.message) setError(result.view.message);
    setBusy(false);
    if (result.ok) {
      onChanged?.();
      return true;
    }
    return false;
  };

  const addPhone = async () => {
    const ok = await act({ action: "add", phone: phone.trim(), firstName: name.trim(), agreed });
    if (ok) {
      setAdding(false);
      setPhone("");
      setName("");
      setAgreed(false);
    }
  };

  return (
    <>
      <PortalIconAction
        icon={MessagesSquare}
        label="Text group"
        onClick={() => setOpen(true)}
        data-attr="house-chat-text-group"
      />
      <PortalDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Text group"
        dataAttr="house-sms-group-dialog"
        primaryAction={
          view.exists
            ? null
            : { label: "Create text group", onClick: () => act({ action: "enable" }), loading: busy, disabled: busy, dataAttr: "house-sms-group-create" }
        }
        headerAction={
          view.exists ? (
            <PortalIconAction icon={Plus} label="Add a phone" onClick={() => setAdding((v) => !v)} data-attr="house-sms-group-add" />
          ) : null
        }
      >
        <div className="space-y-4">
          {loading ? <p className="text-sm text-muted">Loading…</p> : null}
          {view.exists ? (
            <>
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold">{view.status === "active" ? "Live" : "Waiting for a second phone"}</span>
                {view.maskedLine ? <span className="tabular-nums text-muted">From {view.maskedLine}</span> : null}
              </div>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {view.members.length === 0 ? <li className="px-3 py-3 text-sm text-muted">No phones yet.</li> : null}
                {view.members.map((m) => (
                  <li key={m.phoneKey} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">
                        {m.firstName || (m.kind === "staff" ? "Team" : "Resident")}
                        {m.roomLabel ? ` · ${m.roomLabel}` : ""}
                      </p>
                      <p className="tabular-nums text-xs text-muted">{m.maskedPhone}</p>
                    </div>
                    <PortalIconAction
                      icon={Trash2}
                      label="Remove"
                      ariaLabel={`Remove ${m.firstName || "member"}`}
                      tone="danger"
                      disabled={busy}
                      onClick={() => void act({ action: "remove", phoneKey: m.phoneKey })}
                      data-attr="house-sms-group-remove"
                    />
                  </li>
                ))}
              </ul>
              {adding ? (
                <div className="space-y-3 rounded-lg border border-border p-3">
                  <label className="block">
                    <span className={POPUP_FIELD_LABEL_CLASS}>Name</span>
                    <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
                  </label>
                  <label className="block">
                    <span className={POPUP_FIELD_LABEL_CLASS}>Phone</span>
                    <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="off" placeholder="Leave empty to add yourself" />
                  </label>
                  {phone.trim() ? (
                    <label className="flex min-h-11 items-center gap-2 text-sm">
                      <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                      <span>They agreed to join</span>
                    </label>
                  ) : null}
                  <button
                    type="button"
                    className="min-h-11 rounded-lg bg-[var(--btn-primary)] px-4 text-sm font-semibold text-white disabled:opacity-50 lg:min-h-9"
                    disabled={busy || (Boolean(phone.trim()) && !agreed)}
                    onClick={() => void addPhone()}
                    data-attr="house-sms-group-add-save"
                  >
                    Add
                  </button>
                </div>
              ) : null}
            </>
          ) : loading ? null : (
            <p className="text-sm text-muted">No text group for this house yet.</p>
          )}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </PortalDialog>
    </>
  );
}
