"use client";

import { useEffect, useRef, useState } from "react";

import { PortalDialog } from "@/components/portal/portal-dialog";

type PickedSheet = { id: string; name: string };

type PickerToken = {
  accessToken: string;
  apiKey: string | null;
  clientId: string | null;
  appId: string | null;
};

/** Google's picker callback payload — only the fields this component reads. */
type GooglePickerData = { action: string; docs?: Array<{ id?: string; name?: string }> };

/**
 * The builder is fluent: every setter returns the builder itself. Typing the
 * setters as `unknown` broke the chain and the callback's parameter, so each
 * one names the builder type instead.
 */
type GooglePickerBuilder = {
  addView: (view: unknown) => GooglePickerBuilder;
  setOAuthToken: (token: string) => GooglePickerBuilder;
  setDeveloperKey: (key: string) => GooglePickerBuilder;
  /** Required for `drive.file` to actually grant the picked file to this app's project. */
  setAppId: (appId: string) => GooglePickerBuilder;
  setCallback: (cb: (data: GooglePickerData) => void) => GooglePickerBuilder;
  build: () => { setVisible: (visible: boolean) => void };
};

declare global {
  interface Window {
    gapi?: { load: (name: string, cb: () => void) => void };
    google?: {
      picker: {
        PickerBuilder: new () => GooglePickerBuilder;
        ViewId: { SPREADSHEETS: unknown };
        Action: { PICKED: string; CANCEL: string };
      };
    };
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not open Google."));
    document.head.appendChild(script);
  });
}

async function openOfficialPicker(token: PickerToken): Promise<PickedSheet | null> {
  if (!token.apiKey) return null;
  await loadScript("https://apis.google.com/js/api.js");
  await new Promise<void>((resolve) => {
    if (!window.gapi) {
      resolve();
      return;
    }
    window.gapi.load("picker", () => resolve());
  });
  const pickerApi = window.google?.picker;
  if (!pickerApi) return null;
  return new Promise((resolve) => {
    let builder = new pickerApi.PickerBuilder()
      .addView(pickerApi.ViewId.SPREADSHEETS)
      .setOAuthToken(token.accessToken)
      .setDeveloperKey(token.apiKey!);
    if (token.appId) builder = builder.setAppId(token.appId);
    builder = builder.setCallback((data) => {
      if (data.action === pickerApi.Action.CANCEL) {
        resolve(null);
        return;
      }
      if (data.action === pickerApi.Action.PICKED) {
        const doc = data.docs?.[0];
        const id = doc?.id?.trim() || "";
        resolve(id ? { id, name: doc?.name?.trim() || "Spreadsheet" } : null);
      }
    });
    const picker = builder.build();
    picker.setVisible(true);
  });
}

export function GoogleSpreadsheetPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (sheet: PickedSheet) => void | Promise<void>;
}) {
  const onPickRef = useRef(onPick);
  const onCloseRef = useRef(onClose);
  // The picker callback fires long after render, so it reads the latest
  // handlers through refs — kept current in an effect, never during render.
  useEffect(() => {
    onPickRef.current = onPick;
    onCloseRef.current = onClose;
  }, [onPick, onClose]);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showError, setShowError] = useState(false);

  useEffect(() => {
    if (!open) {
      setShowError(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setError(null);
    setLoading(true);
    setShowError(false);
    void (async () => {
      try {
        const tokenRes = await fetch("/api/portal/google-sheets/picker-token", { credentials: "include", cache: "no-store" });
        const tokenBody = (await tokenRes.json().catch(() => null)) as (PickerToken & { error?: string }) | null;
        if (!tokenRes.ok || !tokenBody?.accessToken) {
          throw new Error(tokenBody?.error || "Connect Google first.");
        }
        if (!tokenBody.apiKey) {
          throw new Error("Google's file picker is not configured on this server.");
        }
        const official = await openOfficialPicker(tokenBody);
        if (cancelled) return;
        if (official) {
          await onPickRef.current(official);
          onCloseRef.current();
          return;
        }
        // The user closed the Google picker without choosing a file, or the
        // picker script never loaded. Either way there is nothing left to
        // pick from here — the restricted file-listing fallback is gone
        // (BUILD-WAVE2 C210). A cancel just closes; a load failure shows why.
        if (window.google?.picker) {
          onCloseRef.current();
          return;
        }
        throw new Error("Could not open Google's file picker. Pick the sheet again.");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not open Google.");
          setShowError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open || (!showError && !loading)) return null;

  return (
    <PortalDialog open={open} onClose={onClose} title="Select a spreadsheet">
      {loading ? <p className="text-sm text-muted-foreground">Opening Google…</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </PortalDialog>
  );
}
