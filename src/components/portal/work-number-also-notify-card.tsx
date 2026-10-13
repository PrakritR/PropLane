"use client";

/**
 * Settings → Communication → "Also notify": people who are not PropLane accounts but get every
 * manager notice the work number sends (bookings, tours, payments) - a text from the work number
 * and an email from the work email. Rows are "name · phone · email" with a ⋯ holding Remove; the
 * round + opens the standard popup (the New property wizard shell) with Name / Phone / Email.
 * Owner or a teammate with Team at edit manages it; the route enforces that, this just asks.
 */
import { useCallback, useEffect, useState } from "react";
import { AddWorkspace } from "@/components/portal/add-workspace";
import { WizardField, WizardSection } from "@/components/portal/add-workspace/parts";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";
import { WORKSPACE_SELECTION_EVENT } from "@/lib/workspaces/selection";

type Recipient = { id: string; label: string; phone: string | null; email: string | null };

export function WorkNumberAlsoNotifyCard({ ownerUserId }: { ownerUserId?: string | null }) {
  const [rows, setRows] = useState<Recipient[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = ownerUserId ? `?ownerUserId=${encodeURIComponent(ownerUserId)}` : "";

  const load = useCallback(() => {
    void fetch(`/api/pro/work-number-recipients${query}`, { credentials: "include", cache: "no-store" })
      .then(async (res) => (res.ok ? ((await res.json()) as { recipients?: Recipient[] }) : null))
      .then((data) => setRows(data?.recipients ?? []))
      .catch(() => undefined);
  }, [query]);

  useEffect(() => {
    load();
    window.addEventListener(WORKSPACE_SELECTION_EVENT, load);
    return () => window.removeEventListener(WORKSPACE_SELECTION_EVENT, load);
  }, [load]);

  if (isDemoModeActive()) return null;

  const reset = () => {
    setName("");
    setPhone("");
    setEmail("");
    setError(null);
  };
  const canSave = name.trim().length > 0 && (phone.trim().length > 0 || email.trim().length > 0) && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/pro/work-number-recipients", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerUserId: ownerUserId || undefined, label: name, phone, email }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(json.error ?? "Could not save.");
        return;
      }
      reset();
      setOpen(false);
      load();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/pro/work-number-recipients?id=${encodeURIComponent(id)}${ownerUserId ? `&ownerUserId=${encodeURIComponent(ownerUserId)}` : ""}`, {
      method: "DELETE",
      credentials: "include",
    }).catch(() => undefined);
    load();
  };

  return (
    <PortalSettingsSection
      title="Also notify"
      action={<PortalPrimaryIconAction label="Add person" onClick={() => { reset(); setOpen(true); }} data-attr="work-number-also-notify-add" />}
    >
      {rows.length > 0 ? (
        <PortalSettingsGroup>
          {rows.map((row) => (
            <PortalSettingsRow key={row.id} label={row.label}>
              <div className="flex items-center gap-1">
                <span className="text-sm text-muted">
                  {[row.phone ? formatSmsPhoneLabel(row.phone) || row.phone : null, row.email].filter(Boolean).join(" · ")}
                </span>
                <RecordActionContext.Provider
                  value={{
                    scope: `also-notify-${row.id}`,
                    clear: () => {},
                    actions: (
                      <Button type="button" variant="danger" data-record-action-id="delete" data-attr="work-number-also-notify-remove" onClick={() => void remove(row.id)}>
                        Remove
                      </Button>
                    ),
                  }}
                >
                  <RecordActionMenu label={row.label} activate={() => {}} />
                </RecordActionContext.Provider>
              </div>
            </PortalSettingsRow>
          ))}
        </PortalSettingsGroup>
      ) : null}
      {open ? (
        <div data-attr="work-number-also-notify-popup">
          <AddWorkspace
            title="Also notify"
            steps={[{ id: "person", label: "Person", incomplete: !canSave, summary: name.trim() || "Add a name" }]}
            current={0}
            onJump={() => undefined}
            onClose={() => { reset(); setOpen(false); }}
            dirty={Boolean(name || phone || email)}
            discardTitle="Discard this person?"
            assistantContext="Adding a person who gets every notice from the work number."
            assistantScopeKey="work-number-also-notify"
            lastLabel="Add person"
            lastDisabled={!canSave}
            busy={busy}
            onFinish={() => void save()}
            dataAttrPrefix="work-number-also-notify"
            hideFooterStepCount
          >
            <WizardSection title="Person">
              <WizardField label="Name" required>
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" data-attr="work-number-also-notify-name" />
              </WizardField>
              <div className="mt-4">
                <WizardField label="Phone">
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="off" data-attr="work-number-also-notify-phone" />
                </WizardField>
              </div>
              <div className="mt-4">
                <WizardField label="Email">
                  <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="off" data-attr="work-number-also-notify-email" />
                </WizardField>
              </div>
              {error ? (
                <p role="alert" className="mt-3 text-sm font-semibold text-danger">
                  {error}
                </p>
              ) : null}
            </WizardSection>
          </AddWorkspace>
        </div>
      ) : null}
    </PortalSettingsSection>
  );
}
