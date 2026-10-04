"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, MoreHorizontal, X } from "lucide-react";
import { FactRow } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PropertyFormWizardRow } from "@/components/portal/property-form-wizard-kit";
import { WaiveCodesSettingsSection } from "@/components/portal/settings-waive-codes-section";
import { useOptionalAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { RECORD_ACTION_TRIGGER_ICON_CLASS } from "@/components/ui/record-action-menu";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  isValidWaiverCodeFormat,
  normalizeWaiverCode,
  waiverCodeAppliesToFee,
  waiverCodeCoversProperty,
  type ApplicationFeeWaiverCode,
} from "@/lib/application-fee-waiver";

/**
 * "Promo codes" on an Application or a Lease card: opens the EXISTING waive-code list (Settings ->
 * Waive codes, `/api/manager/application-fee-waivers`) in a standard dialog, scoped to this property and
 * to the fee the form owns -- an application's codes waive its Application fee, a lease's its Lease fee.
 * There is no second code system: create, cap, expire and disable all run through that section.
 * This is the "Manage codes" door of {@link FormPromoCodesRow}, which carries the everyday path inline.
 */
export function FormPromoCodesDialog({
  open,
  onClose,
  kind,
  propertyId,
  propertyLabel,
}: {
  open: boolean;
  onClose: () => void;
  kind: "application" | "lease";
  /** The saved property the codes apply on; absent on a draft that is not saved yet (then every property). */
  propertyId?: string | null;
  propertyLabel?: string | null;
}) {
  const id = propertyId?.trim() ?? "";
  return (
    <PortalDialog
      open={open}
      onClose={onClose}
      title="Promo codes"
      primaryAction={null}
      dataAttr={`${kind}-promo-codes-dialog`}
    >
      <WaiveCodesSettingsSection
        propertyOptions={id ? [{ id, label: propertyLabel?.trim() || "This property" }] : []}
        defaultAppliesTo={kind}
        show={kind}
      />
    </PortalDialog>
  );
}

const API = "/api/manager/application-fee-waivers";

/**
 * "Promo codes" row on an Application or Lease card: type a code, press Add (or Enter), and it is created
 * through the EXISTING waive-code API as a full waive of THIS form's fee (application fee on an application,
 * lease fee on a lease), limited to this property. The codes already on the form list underneath as plain
 * rows: the code, what it does (the waive model has one effect, "Free"), its uses, and a ⋯ menu.
 *
 * The client sends only the code text, the fee and the property id; the server re-derives the manager from
 * the session and refuses a property that is not theirs. A brand-new draft has no property id yet, so it is
 * saved first through `ensureSaved` (the same save the PDF upload uses). With neither an id nor
 * `ensureSaved` (the workspace-level editor) the code is workspace-wide, as the dialog always was.
 */
export function FormPromoCodesRow({
  kind,
  propertyId,
  propertyLabel,
  ensureSaved,
  dataAttr,
  variant,
}: {
  kind: "application" | "lease";
  propertyId?: string | null;
  propertyLabel?: string | null;
  ensureSaved?: () => Promise<string | null>;
  /** Goes on the code input. */
  dataAttr: string;
  /** `fact` = the listing wizard's FactRow; `wizard` = the property form modals' row. */
  variant: "fact" | "wizard";
}) {
  const showToast = useOptionalAppUi()?.showToast;
  const demo = isDemoModeActive();
  const knownId = propertyId?.trim() || "";
  const [savedId, setSavedId] = useState("");
  const scopeId = knownId || savedId;
  const workspaceWide = !scopeId && !ensureSaved;
  const [codes, setCodes] = useState<ApplicationFeeWaiverCode[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offId, setOffId] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(API, { credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as { codes?: ApplicationFeeWaiverCode[] };
      if (res.ok && Array.isArray(data.codes)) setCodes(data.codes);
    } catch {
      // The list is a convenience; typing a code still works without it.
    }
  }, []);

  useEffect(() => {
    // /demo never writes real rows, so it never reads them either (the row stays, inert); a draft with no id has none yet.
    if (!demo && (scopeId || workspaceWide)) void load();
  }, [demo, scopeId, workspaceWide, load]);

  const shown = codes.filter(
    (c) =>
      c.status === "active" &&
      waiverCodeAppliesToFee(c.appliesTo, kind) &&
      (scopeId ? waiverCodeCoversProperty(c, scopeId) : c.propertyIds.length === 0 && !c.propertyId),
  );

  async function add() {
    const code = normalizeWaiverCode(text);
    if (!code || busy || demo) return;
    if (!isValidWaiverCodeFormat(code)) {
      setError("Codes must be 4-32 letters, numbers, or hyphens.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let id = scopeId;
      if (!id && ensureSaved) {
        id = (await ensureSaved())?.trim() ?? "";
        if (!id) {
          setError("Could not save the property. No code was added.");
          return;
        }
        setSavedId(id);
      }
      const res = await fetch(API, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, appliesTo: kind, propertyIds: id ? [id] : [] }),
      });
      const data = (await res.json().catch(() => ({}))) as { code?: ApplicationFeeWaiverCode; error?: string };
      if (!res.ok || !data.code) {
        setError(data.error ?? "Could not add that code.");
        return;
      }
      const created = data.code;
      setCodes((prev) => [...prev.filter((c) => c.id !== created.id), created]);
      setText("");
    } catch {
      setError("Could not add that code.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`${API}/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke" }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not turn that code off.");
        return;
      }
      setError(null);
      setOffId(null);
      setCodes((prev) => prev.filter((c) => c.id !== id));
    } catch {
      setError("Could not turn that code off.");
    } finally {
      setBusy(false);
    }
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      showToast?.("Copied");
    } catch {
      showToast?.("Could not copy that code.");
    }
  }

  const control = (
    <div className="flex items-center gap-1.5">
      <Input
        aria-label="Promo code"
        placeholder="Type a code"
        className="w-36 font-mono uppercase"
        value={text}
        disabled={busy || demo}
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        data-attr={dataAttr}
        onChange={(e) => {
          setText(e.target.value.toUpperCase());
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          void add();
        }}
      />
      <Button type="button" variant="secondary" disabled={busy || demo || !text.trim()} data-attr={`${dataAttr}-add`} onClick={() => add()}>
        Add
      </Button>
    </div>
  );

  const rowClass = variant === "fact" ? "px-3.5" : "px-0";
  const list = (
    <>
      {error ? (
        <p role="alert" className={`${rowClass} border-t border-border/80 py-2 text-[13px] text-danger`} data-attr={`${dataAttr}-error`}>
          {error}
        </p>
      ) : null}
      {shown.map((code) => (
        <div
          key={code.id}
          className={`${rowClass} flex min-h-11 items-center gap-3 border-t border-border/80 py-1`}
          data-attr="form-promo-code-row"
        >
          <span className="min-w-0 truncate font-mono text-[14px] font-semibold tracking-tight text-foreground">{code.code}</span>
          <span className="shrink-0 text-[13px] text-muted">Free</span>
          <span className="ml-auto shrink-0 text-[13px] tabular-nums text-muted">
            {code.maxUses == null ? `Used ${code.usedCount}` : `Used ${code.usedCount} of ${code.maxUses}`}
          </span>
          {offId === code.id ? (
            <span className="flex shrink-0 items-center">
              <PortalIconAction label="Confirm turn off" icon={Check} tone="danger" disabled={busy} data-attr="form-promo-code-off-confirm" onClick={() => turnOff(code.id)} />
              <PortalIconAction label="Keep code" icon={X} disabled={busy} data-attr="form-promo-code-off-cancel" onClick={() => setOffId(null)} />
            </span>
          ) : (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger
                type="button"
                aria-label={`Actions for ${code.code}`}
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:size-9"
                data-attr="form-promo-code-menu"
              >
                <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem data-attr="form-promo-code-copy" onSelect={() => void copy(code.code)}>
                  Copy
                </DropdownMenuItem>
                <DropdownMenuItem data-attr="form-promo-code-manage" onSelect={() => setManageOpen(true)}>
                  Manage codes
                </DropdownMenuItem>
                <DropdownMenuItem className="text-danger" data-attr="form-promo-code-off" onSelect={() => setOffId(code.id)}>
                  Turn off
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      ))}
      <FormPromoCodesDialog
        open={manageOpen}
        onClose={() => {
          setManageOpen(false);
          void load();
        }}
        kind={kind}
        propertyId={scopeId}
        propertyLabel={propertyLabel}
      />
    </>
  );

  return variant === "fact" ? (
    <>
      <FactRow label="Promo codes">{control}</FactRow>
      {list}
    </>
  ) : (
    <>
      <PropertyFormWizardRow label="Promo codes" className="border-b-0">
        <div className="flex justify-end">{control}</div>
      </PropertyFormWizardRow>
      {list}
    </>
  );
}
