"use client";

/**
 * Settings -> Automations -> Check-in and check-out messages (design-1112 §7). The settings kit only: a toggle per source, a
 * number per source, two plain textareas and a field picker. No descriptive text under any row.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeE164 } from "@/lib/phone-e164";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection, PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { useSettingsPropertyScope } from "@/components/portal/settings-property-scope";
import { useReportSettingsSaveStatus } from "@/components/portal/settings-save-status-context";
import {
  DEFAULT_CHECK_IN_TEMPLATE,
  DEFAULT_CHECK_OUT_TEMPLATE,
  DEFAULT_STAY_MESSAGE_SETTINGS,
  STAY_MESSAGE_FIELDS,
  STAY_SOURCES,
  STAY_SOURCE_LABEL,
  normalizeStayMessageSettings,
  type StayMessageSettings,
  type StaySource,
} from "@/lib/stay-messages/templates";

const FIELD_LABEL: Record<(typeof STAY_MESSAGE_FIELDS)[number], string> = {
  first_name: "First name",
  property: "House",
  room: "Room",
  address: "Address",
  check_in_day: "Check-in day",
  check_in_time: "Check-in time",
  front_door_code: "Front door code",
  gate_code: "Gate code",
  room_code: "Room door code",
  wifi_network: "Wi-Fi network",
  wifi_password: "Wi-Fi password",
  bathroom_rule: "Bathroom rule",
  checkout_time: "Check-out time",
  checkout_steps: "Check-out steps",
  contact_phone: "Contact phone",
};

const AREA = "w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[12.5px] leading-relaxed text-foreground";
const INPUT = "w-44 rounded-lg border border-border bg-surface px-3 py-2 text-[13.5px] text-foreground";

function TemplateField({ label, value, fallback, dataAttr, onCommit }: { label: string; value: string; fallback: string; dataAttr: string; onCommit: (next: string) => void }) {
  const [draft, setDraft] = useState(value);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const insert = (field: string) => {
    if (!field) return;
    const el = area.current;
    const at = el?.selectionStart ?? draft.length;
    const next = `${draft.slice(0, at)}{${field}}${draft.slice(at)}`;
    setDraft(next);
    onCommit(next);
  };
  return (
    <div className="flex flex-col gap-2 border-b border-border/70 px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={dataAttr} className="text-[13px] text-muted">{label}</label>
        <div className="flex items-center gap-2">
          <FieldSingleSelect
            hideLabel
            label={`Add a field to ${label}`}
            variant="cell"
            wrapperClassName="w-44"
            value=""
            options={[{ value: "", label: "Add field" }, ...STAY_MESSAGE_FIELDS.map((field) => ({ value: field, label: FIELD_LABEL[field] }))]}
            dataAttr={`${dataAttr}-field`}
            onChange={insert}
          />
          <button type="button" className="text-[12.5px] font-semibold text-primary underline-offset-2 hover:underline" data-attr={`${dataAttr}-reset`} onClick={() => { setDraft(fallback); onCommit(fallback); }}>
            Reset
          </button>
        </div>
      </div>
      <textarea id={dataAttr} ref={area} rows={10} className={AREA} value={draft} data-attr={dataAttr} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== value && onCommit(draft)} />
    </div>
  );
}

export function StayMessagesSettingsSection() {
  const { workspaceId } = useSettingsPropertyScope();
  const report = useReportSettingsSaveStatus();
  const [settings, setSettings] = useState<StayMessageSettings>(DEFAULT_STAY_MESSAGE_SETTINGS);
  const [ready, setReady] = useState(false);
  const [bump, setBump] = useState(0);
  const url = `/api/portal/stay-messages-settings${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`;

  useEffect(() => {
    let live = true;
    void fetch(url, { cache: "no-store", credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { settings?: unknown } | null) => {
        if (!live) return;
        if (body?.settings) setSettings(normalizeStayMessageSettings(body.settings));
        setReady(true);
      })
      .catch(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [url]);

  const save = useCallback(
    async (next: StayMessageSettings) => {
      setSettings(next);
      report({ type: "start" });
      try {
        const res = await fetch(url, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: next }) });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not save.");
        report({ type: "success" });
      } catch (cause) {
        report({ type: "failure", reason: cause instanceof Error ? cause.message : "Could not save." });
      }
    },
    [report, url],
  );

  const setSource = (source: StaySource, on: boolean) => void save({ ...settings, sources: { ...settings.sources, [source]: on } });
  const setPhone = (source: StaySource, value: string) => {
    const phone = normalizeE164(value);
    if (!phone) {
      report({ type: "failure", reason: "Enter a valid phone number, like +12065550100." });
      setBump((n) => n + 1);
      return;
    }
    void save({ ...settings, contactPhone: { ...settings.contactPhone, [source]: phone } });
  };

  return (
    <PortalSettingsSection id="stay-messages" title="Check-in and check-out messages">
      <PortalSettingsGroup>
        {STAY_SOURCES.map((source) => (
          <PortalSettingsRow key={source} label={STAY_SOURCE_LABEL[source]}>
            <PortalSettingsToggle checked={settings.sources[source]} disabled={!ready} label={`Send to ${STAY_SOURCE_LABEL[source]}`} dataAttr={`stay-messages-source-${source}`} onChange={(on) => setSource(source, on)} />
          </PortalSettingsRow>
        ))}
      </PortalSettingsGroup>
      <PortalSettingsGroup>
        {STAY_SOURCES.map((source) => (
          <PortalSettingsRow key={`phone-${source}`} label={`${STAY_SOURCE_LABEL[source]} phone`}>
            <input
              className={INPUT}
              inputMode="tel"
              aria-label={`Contact phone for ${STAY_SOURCE_LABEL[source]}`}
              data-attr={`stay-messages-phone-${source}`}
              defaultValue={settings.contactPhone[source]}
              key={`${source}-${settings.contactPhone[source]}-${ready}-${bump}`}
              disabled={!ready}
              onBlur={(e) => e.target.value.trim() !== settings.contactPhone[source] && setPhone(source, e.target.value)}
            />
          </PortalSettingsRow>
        ))}
      </PortalSettingsGroup>
      <PortalSettingsGroup>
        <TemplateField key={settings.templates.checkIn} label="Check-in message" value={settings.templates.checkIn} fallback={DEFAULT_CHECK_IN_TEMPLATE} dataAttr="stay-messages-template-check-in" onCommit={(checkIn) => void save({ ...settings, templates: { ...settings.templates, checkIn } })} />
        <TemplateField key={settings.templates.checkOut} label="Check-out message" value={settings.templates.checkOut} fallback={DEFAULT_CHECK_OUT_TEMPLATE} dataAttr="stay-messages-template-check-out" onCommit={(checkOut) => void save({ ...settings, templates: { ...settings.templates, checkOut } })} />
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}
