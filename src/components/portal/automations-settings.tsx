"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Megaphone, MessageSquare, Send, Users, X } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Textarea } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import {
  decideHeldRun,
  fetchAutomations,
  previewAutomation,
  saveAutomation,
  sendAnnouncement,
  type AutomationRowView,
  type AutomationsView,
} from "@/lib/automations/client";
import { MODE_LABELS, getAutomationPreset, type AutomationMode } from "@/lib/automations/presets";

function PresetGlyph({ audience }: { audience: "resident" | "group" }) {
  const Icon = audience === "group" ? Users : MessageSquare;
  return (
    <Icon
      className="size-4 shrink-0 text-muted"
      strokeWidth={1.75}
      aria-label={audience === "group" ? "House group" : "One on one"}
      role="img"
    />
  );
}

/**
 * Settings, Communication, Automations: the preset auto-sends. One row per moment (name, a glyph for
 * where it goes, and the mode), a menu to edit the wording, and the drafts waiting for a tap. A
 * workspace that has never picked keeps every default; the first pick on any row opts it in.
 */
export function AutomationsSection() {
  const [view, setView] = useState<AutomationsView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<AutomationRowView | null>(null);
  const [announceOpen, setAnnounceOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => setView(await fetchAutomations()), []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!view) return null;
  const labelFor = (id: string) => getAutomationPreset(id)?.label ?? id;
  const houseLabel = (id: string | null) => view.houses.find((h) => h.id === id)?.label ?? null;

  return (
    <PortalSettingsSection
      title="Automations"
      action={
        <PortalIconAction
          icon={Megaphone}
          label="Announce to residents"
          data-attr="automations-announce"
          onClick={() => setAnnounceOpen(true)}
        />
      }
    >
      {view.held.length > 0 ? (
        <PortalSettingsGroup>
          {view.held.map((run) => (
            <PortalSettingsRow
              key={run.id}
              label={
                <span className="flex min-w-0 items-center gap-2">
                  <PresetGlyph audience={run.audience} />
                  <span className="truncate" title={run.body}>
                    {[houseLabel(run.propertyId), labelFor(run.preset)].filter(Boolean).join(" · ")}
                  </span>
                </span>
              }
            >
              <span className="flex items-center gap-1">
                <PortalIconAction
                  icon={Send}
                  label="Send"
                  ariaLabel={`Send ${labelFor(run.preset)}`}
                  tone="primary"
                  data-attr="automation-held-send"
                  disabled={busy === run.id}
                  onClick={async () => {
                    setBusy(run.id);
                    const result = await decideHeldRun(run.id, "send");
                    setNotice(result.ok ? null : (result.error ?? "Could not send."));
                    setBusy(null);
                    await load();
                  }}
                />
                <PortalIconAction
                  icon={X}
                  label="Dismiss"
                  ariaLabel={`Dismiss ${labelFor(run.preset)}`}
                  data-attr="automation-held-dismiss"
                  disabled={busy === run.id}
                  onClick={async () => {
                    setBusy(run.id);
                    await decideHeldRun(run.id, "dismiss");
                    setBusy(null);
                    await load();
                  }}
                />
              </span>
            </PortalSettingsRow>
          ))}
        </PortalSettingsGroup>
      ) : null}

      <PortalSettingsGroup>
        {view.presets.map((row) => (
          <PortalSettingsRow
            key={row.id}
            label={
              <span className="flex min-w-0 items-center gap-2">
                <PresetGlyph audience={row.audience} />
                <span className="truncate">{row.label}</span>
              </span>
            }
          >
            <span className="flex items-center gap-1">
              <FieldSingleSelect
                variant="cell"
                hideLabel
                label={`${row.label} mode`}
                value={row.mode}
                disabled={!view.canEdit || busy === row.id}
                onChange={async (next) => {
                  setBusy(row.id);
                  const result = await saveAutomation({ preset: row.id, mode: next as AutomationMode });
                  setNotice(result.ok ? null : (result.error ?? "Could not save."));
                  await load();
                  setBusy(null);
                }}
                options={row.modes.map((mode) => ({ value: mode, label: MODE_LABELS[mode] }))}
                wrapperClassName="w-56"
                dataAttr={`automation-mode-${row.id}`}
              />
              {row.hasOwnText && view.canEdit ? (
                <RowActionsMenu
                  label={row.label}
                  items={[{ id: "edit", label: "Edit text", onSelect: () => setEditing(row) }]}
                />
              ) : null}
            </span>
          </PortalSettingsRow>
        ))}
      </PortalSettingsGroup>
      {notice ? (
        <p className="text-sm text-danger" role="alert">
          {notice}
        </p>
      ) : null}

      <AutomationTextModal
        row={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
      <AnnounceModal
        open={announceOpen}
        houses={view.houses}
        onClose={() => setAnnounceOpen(false)}
        onDone={() => void load()}
      />
    </PortalSettingsSection>
  );
}

/** Edit one preset's wording. Variables come from a plain dropdown, never chips; the preview is real data. */
export function AutomationTextModal({
  row,
  onClose,
  onSaved,
}: {
  row: AutomationRowView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The caret, remembered from the textarea's own events, so Insert lands where the manager was typing.
  const caretRef = useRef<{ start: number; end: number } | null>(null);

  useEffect(() => {
    if (!row) return;
    setText(row.template);
    setError(null);
  }, [row]);

  // The preview follows the text, a beat behind the typing.
  useEffect(() => {
    if (!row) return;
    const timer = window.setTimeout(async () => {
      const result = await previewAutomation(row.id, text);
      if (result.ok) {
        setPreview(result.text);
        setPreviewError(null);
      } else {
        setPreview(null);
        setPreviewError(result.error);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [row, text]);

  const defaultTemplate = useMemo(() => (row ? getAutomationPreset(row.id)?.template ?? "" : ""), [row]);
  if (!row) return null;

  const insert = (variable: string) => {
    const token = `{${variable}}`;
    const caret = caretRef.current;
    const start = Math.min(caret?.start ?? text.length, text.length);
    const end = Math.min(caret?.end ?? text.length, text.length);
    setText(`${text.slice(0, start)}${token}${text.slice(end)}`);
    caretRef.current = { start: start + token.length, end: start + token.length };
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const result = await saveAutomation({ preset: row.id, template: text });
    setSaving(false);
    if (!result.ok) {
      setError(result.error ?? "Could not save.");
      return;
    }
    onSaved();
  };

  return (
    <Modal
      open
      title={row.label}
      onClose={onClose}
      presentation="dialog"
      dense
      panelClassName="max-w-xl"
      stackClassName="fixed inset-0 z-[80] overflow-y-auto overscroll-contain"
      footer={
        <ModalFooter>
          {text.trim() !== defaultTemplate ? (
            <Button type="button" variant="outline" className="rounded-full" data-attr="automation-text-reset" onClick={() => setText(defaultTemplate)}>
              Use standard text
            </Button>
          ) : null}
          <Button type="button" variant="primary" className="rounded-full" data-attr="automation-text-save" onClick={() => save()}>
            Save
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium text-foreground">Text</p>
          <Textarea
            value={text}
            maxLength={320}
            rows={4}
            onChange={(e) => {
              caretRef.current = { start: e.target.selectionStart, end: e.target.selectionEnd };
              setText(e.target.value);
            }}
            onSelect={(e) => {
              caretRef.current = { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd };
            }}
            className="mt-1"
            data-attr="automation-text"
          />
        </div>
        <FieldSingleSelect
          label="Insert"
          value=""
          placeholder="Choose an item"
          onChange={(next) => next && insert(next)}
          options={row.variables.map((v) => ({ value: v.id, label: v.label }))}
          dataAttr="automation-insert"
        />
        <div>
          <p className="text-sm font-medium text-foreground">Preview</p>
          <div
            className="mt-1 whitespace-pre-wrap rounded-2xl border border-border bg-card px-3.5 py-3 text-sm text-foreground"
            data-attr="automation-preview"
          >
            {previewError ?? preview ?? " "}
          </div>
        </div>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** Announce to one house or all of them. The text is the manager's; names, amounts and codes are refused. */
export function AnnounceModal({
  open,
  houses,
  onClose,
  onDone,
}: {
  open: boolean;
  houses: Array<{ id: string; label: string }>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [text, setText] = useState("");
  const [house, setHouse] = useState<string>("all");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [announcementId, setAnnouncementId] = useState("");

  useEffect(() => {
    if (!open) return;
    setText("");
    setHouse(houses.length === 1 ? houses[0]!.id : "all");
    setError(null);
    setResult(null);
    setAnnouncementId(typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()));
  }, [open, houses]);

  if (!open) return null;

  const send = async () => {
    setSending(true);
    setError(null);
    const response = await sendAnnouncement({ text, houseIds: house === "all" ? "all" : [house], announcementId });
    setSending(false);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    onDone();
    if (response.off) setResult("Announcements are switched off.");
    else if (response.held > 0 && response.sent === 0) setResult("Saved as a draft. Send it from the list.");
    else setResult(`Sent to ${response.sent} ${response.sent === 1 ? "house" : "houses"}.`);
  };

  return (
    <Modal
      open
      title="Announce"
      onClose={onClose}
      presentation="dialog"
      dense
      panelClassName="max-w-xl"
      stackClassName="fixed inset-0 z-[80] overflow-y-auto overscroll-contain"
      footer={
        <ModalFooter>
          {result ? (
            <Button type="button" variant="primary" className="rounded-full" onClick={onClose}>
              Done
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              data-attr="announce-send"
              disabled={sending || !text.trim()}
              onClick={() => send()}
            >
              Send
            </Button>
          )}
        </ModalFooter>
      }
    >
      <div className="space-y-3">
        {result ? (
          <p className="text-sm text-foreground" role="status">
            {result}
          </p>
        ) : (
          <>
            <FieldSingleSelect
              label="Houses"
              value={house}
              onChange={setHouse}
              options={[{ value: "all", label: "All houses" }, ...houses.map((h) => ({ value: h.id, label: h.label }))]}
              dataAttr="announce-houses"
            />
            <div>
              <p className="text-sm font-medium text-foreground">Announcement</p>
              <Textarea
                value={text}
                maxLength={300}
                rows={4}
                onChange={(e) => setText(e.target.value)}
                className="mt-1"
                placeholder="Water is off Tuesday 9-12."
                data-attr="announce-text"
              />
            </div>
          </>
        )}
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
