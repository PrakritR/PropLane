"use client";

import { useEffect, useMemo, useState } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { PreviewPanel, WizardField, WizardLockedField, WizardMultiSelect, WizardSection, WizardSelect } from "@/components/portal/add-workspace/parts";
import { Input } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";
import { DEFAULT_MANAGEMENT_FEE_PERCENT, MAX_MANAGEMENT_FEE_PERCENT, ownerShareBpsForFeePercent } from "@/lib/owner-management/fee-percent";
import { cleanOwnerOfRecord, cleanServiceCity } from "@/lib/service/service-input";

const API = "/api/admin/service-workspaces";

type AccountWorkspace = { id: string; name: string; city: string | null; houseCount: number; isDefault: boolean };
type Mode = "pick" | "combine";

const MODE_OPTIONS = [
  { value: "pick", label: "Choose workspaces" },
  { value: "combine", label: "Combine all into one" },
];

const houses = (n: number) => `${n} ${n === 1 ? "house" : "houses"}`;

/**
 * Accounts > Managers > row action "Managed by PropLane...". Turns an owner's existing workspaces into PropLane-managed
 * ones: one workspace is confirmed (city, name, fee); several are chosen one by one, or combined into one (the others'
 * houses move into it and the emptied workspaces are archived). The owner keeps their login and is the Property owner
 * of record, view-only. Everything is decided on the server (`manage-by-proplane`); this sheet only names rows.
 */
export function ManagedByProplaneSheet({
  open,
  account,
  onClose,
  onDone,
}: {
  open: boolean;
  account: { id: string; name: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const { showToast } = useAppUi();
  const [workspaces, setWorkspaces] = useState<AccountWorkspace[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("pick");
  const [picked, setPicked] = useState<string[]>([]);
  const [targetId, setTargetId] = useState("");
  const [city, setCity] = useState("");
  const [label, setLabel] = useState("");
  const [fee, setFee] = useState(String(DEFAULT_MANAGEMENT_FEE_PERCENT));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // The caller mounts a fresh sheet (keyed on the account) for every open, so the state starts clean.
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTimeout(
          API,
          { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "account-workspaces", accountUserId: account.id }) },
          25_000,
        );
        const json = (await res.json().catch(() => ({}))) as { workspaces?: AccountWorkspace[]; error?: string };
        if (cancelled) return;
        if (!res.ok || !json.workspaces) {
          setLoadError(json.error ?? "Could not load the workspaces.");
          return;
        }
        setWorkspaces(json.workspaces);
        setPicked(json.workspaces.map((w) => w.id));
        setTargetId(json.workspaces[0]?.id ?? "");
        setCity(json.workspaces[0]?.city ?? "");
        setLabel(json.workspaces.length === 1 ? json.workspaces[0]!.name : "");
        setMode("pick");
      } catch {
        if (!cancelled) setLoadError("Could not reach the server. Try again.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, account.id]);

  const list = useMemo(() => workspaces ?? [], [workspaces]);
  const single = list.length === 1;
  const chosen = useMemo(() => (single ? list : mode === "combine" ? list : list.filter((w) => picked.includes(w.id))), [list, mode, picked, single]);
  const others = mode === "combine" && !single ? list.filter((w) => w.id !== targetId) : [];
  const movedHouses = others.reduce((sum, w) => sum + w.houseCount, 0);
  const cleanCity = cleanServiceCity(city);
  const cleanLabel = cleanOwnerOfRecord(label);
  const feeOk = ownerShareBpsForFeePercent(fee) !== null;
  const valid =
    workspaces !== null &&
    list.length > 0 &&
    cleanCity !== undefined &&
    cleanLabel !== undefined &&
    feeOk &&
    (single || (mode === "pick" ? picked.length > 0 : Boolean(targetId)));
  const steps: AddWorkspaceStep[] = [{ id: "managed", label: "Managed by PropLane", incomplete: !valid }];

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const effectiveMode: Mode = single ? "pick" : mode;
      const res = await fetchWithTimeout(
        API,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "manage-by-proplane",
            accountUserId: account.id,
            mode: effectiveMode,
            workspaceIds: effectiveMode === "combine" ? list.map((w) => w.id) : chosen.map((w) => w.id),
            ...(effectiveMode === "combine" ? { targetId } : {}),
            city: cleanCity,
            ...(single ? { label: cleanLabel } : {}),
            feePercent: Number(fee),
          }),
        },
        45_000,
      );
      const json = (await res.json().catch(() => ({}))) as { error?: string; attached?: string[]; archived?: string[]; feeErrors?: string[] };
      if (!res.ok) {
        setError(json.error ?? "That did not work. Please retry.");
        return;
      }
      const count = json.attached?.length ?? 0;
      showToast(
        json.feeErrors?.length
          ? `Managed by PropLane. The fee did not change: ${json.feeErrors[0]}`
          : effectiveMode === "combine"
            ? `Combined into one workspace managed by PropLane${json.archived?.length ? `; ${json.archived.length} archived` : ""}.`
            : `${count} ${count === 1 ? "workspace is" : "workspaces are"} now managed by PropLane.`,
      );
      onDone();
      onClose();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const options = list.map((w) => ({ value: w.id, label: `${w.name} · ${houses(w.houseCount)}` }));

  return (
    <div data-attr="managed-by-proplane-sheet">
      <AddWorkspace
        title={`Manage ${account.name || "this account"}'s homes by PropLane`}
        steps={steps}
        current={0}
        onJump={() => undefined}
        onClose={onClose}
        dirty={false}
        assistantContext="Making an owner's existing workspaces PropLane-managed."
        assistantScopeKey="managed-by-proplane"
        lastLabel="Manage by PropLane"
        lastDisabled={!valid || busy}
        busy={busy}
        onFinish={() => void submit()}
        dataAttrPrefix="managed-by-proplane"
        finishDataAttr="managed-by-proplane-confirm"
        sidePanel={
          <PreviewPanel
            title="Preview"
            name={account.name || "Owner"}
            sub={workspaces ? `${list.length} ${list.length === 1 ? "workspace" : "workspaces"}` : undefined}
            facts={[
              { label: "Managed", value: mode === "combine" && !single ? "1 workspace" : String(chosen.length) },
              ...(mode === "combine" && !single ? [{ label: "Houses moved", value: String(movedHouses) }, { label: "Archived", value: String(others.length) }] : []),
              { label: "Their role", value: "Property owner" },
            ]}
          />
        }
      >
        <WizardSection title="Workspaces">
          {loadError ? (
            <p role="alert" className="text-sm font-semibold text-danger" data-attr="managed-by-proplane-load-error">
              {loadError}
            </p>
          ) : workspaces === null ? (
            <p className="text-sm text-muted" data-attr="managed-by-proplane-loading">
              Loading…
            </p>
          ) : list.length === 0 ? (
            <p className="text-sm font-semibold" data-attr="managed-by-proplane-empty">
              No workspaces to manage
            </p>
          ) : single ? (
            <WizardLockedField label="Workspace" value={`${list[0]!.name} · ${houses(list[0]!.houseCount)}`} lockTip="The account's only workspace" />
          ) : (
            <div className="space-y-4">
              <WizardSelect label="Which" options={MODE_OPTIONS} value={mode} onChange={(next) => setMode(next === "combine" ? "combine" : "pick")} dataAttr="managed-by-proplane-mode" />
              {mode === "pick" ? (
                <WizardMultiSelect
                  label="Workspaces"
                  options={options}
                  selected={picked}
                  onChange={setPicked}
                  dataAttr="managed-by-proplane-workspaces"
                />
              ) : (
                <WizardSelect label="Keep this workspace" options={options} value={targetId} onChange={setTargetId} dataAttr="managed-by-proplane-target" />
              )}
            </div>
          )}
        </WizardSection>
        <WizardSection title="Terms">
          <div className="space-y-4">
            <WizardField label="City">
              <Input value={city} onChange={(e) => setCity(e.target.value)} maxLength={80} autoComplete="off" placeholder="Seattle" data-attr="managed-by-proplane-city" />
            </WizardField>
            {single ? (
              <WizardField label="Name">
                <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} autoComplete="off" data-attr="managed-by-proplane-label" />
              </WizardField>
            ) : null}
            <WizardField label="Management fee (% of rent)">
              <Input
                value={fee}
                onChange={(e) => setFee(e.target.value)}
                inputMode="decimal"
                autoComplete="off"
                aria-invalid={!feeOk}
                placeholder={`0 to ${MAX_MANAGEMENT_FEE_PERCENT}`}
                data-attr="managed-by-proplane-fee"
              />
            </WizardField>
            <WizardLockedField label="Their role after" value="Property owner (view-only)" lockTip="The owner of a managed workspace is its owner of record, view-only" />
          </div>
          {error ? (
            <p role="alert" className="mt-3 text-sm font-semibold text-danger" data-attr="managed-by-proplane-error">
              {error}
            </p>
          ) : null}
        </WizardSection>
      </AddWorkspace>
    </div>
  );
}
