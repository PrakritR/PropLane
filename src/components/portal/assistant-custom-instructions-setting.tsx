"use client";

import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import {
  PortalSettingsFormBody,
  PortalSettingsGroup,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { isDemoModeActive } from "@/lib/demo/demo-session";

const MAX_LENGTH = 2_000;

/**
 * One server-backed preference per signed-in person. It intentionally uses the
 * generic authenticated route, so the same component works in every portal.
 */
export function AssistantCustomInstructionsSetting({ role }: { role: "manager" | "admin" | "resident" | "vendor" }) {
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isDemoModeActive()) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/agent/preferences", { credentials: "include", cache: "no-store" });
        const body = (await res.json()) as { customInstructions?: string; error?: string };
        if (!res.ok || body.error) throw new Error(body.error ?? "Could not load custom instructions.");
        if (!cancelled) setValue(body.customInstructions ?? "");
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load custom instructions.");
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (isDemoModeActive()) return null;

  async function save(nextValue = value) {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/agent/preferences", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customInstructions: nextValue }),
      });
      const body = (await res.json()) as { customInstructions?: string; error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? "Could not save custom instructions.");
      setValue(body.customInstructions ?? "");
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save custom instructions.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PortalSettingsSection
      title="PropLane Assistant"
    >
      <PortalSettingsGroup>
        <PortalSettingsFormBody>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="space-y-1.5">
              <label htmlFor={fieldId} className="text-sm font-medium text-foreground">
                Custom instructions
              </label>
              <p id={hintId} className="text-xs leading-relaxed text-muted">
                Example: “Keep resident messages friendly and close with ‘Thanks for rooming with me.’”
                {role === "manager" ? " These preferences also guide automated leasing text replies." : ""}
              </p>
              <Textarea
                id={fieldId}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  setSaved(false);
                }}
                disabled={!loaded || saving}
                maxLength={MAX_LENGTH}
                rows={5}
                placeholder="Tell PropLane Assistant how you prefer it to respond or draft messages."
                data-attr="assistant-custom-instructions-input"
                aria-invalid={error ? "true" : undefined}
                aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`}
              />
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted" aria-live="polite">
                  {!loaded ? "Loading…" : `${value.length.toLocaleString()} / ${MAX_LENGTH.toLocaleString()}`}
                </p>
                {saved ? <p className="text-xs font-medium text-emerald-700" aria-live="polite">Saved</p> : null}
              </div>
              {error ? (
                <p id={errorId} className="text-xs text-danger" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                variant="primary"
                className="px-4 text-[13px]"
                disabled={!loaded || saving}
                data-attr="assistant-custom-instructions-save"
              >
                {saving ? "Saving…" : "Save instructions"}
              </Button>
              {value ? (
                <Button
                  type="button"
                  variant="outline"
                  className="px-4 text-[13px]"
                  disabled={!loaded || saving}
                  onClick={() => void save("")}
                  data-attr="assistant-custom-instructions-clear"
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </form>
        </PortalSettingsFormBody>
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}
