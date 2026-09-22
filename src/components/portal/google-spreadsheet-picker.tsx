"use client";

import { useEffect, useRef, useState } from "react";

import { PortalDialog } from "@/components/portal/portal-dialog";

type PickedSheet = { id: string; name: string };

type PickerToken = {
  accessToken: string;
  apiKey: string | null;
  clientId: string | null;
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
    const builder = new pickerApi.PickerBuilder()
      .addView(pickerApi.ViewId.SPREADSHEETS)
      .setOAuthToken(token.accessToken)
      .setDeveloperKey(token.apiKey!)
      .setCallback((data) => {
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
    const picker = (builder as { build: () => { setVisible: (visible: boolean) => void } }).build();
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

  const [files, setFiles] = useState<PickedSheet[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showList, setShowList] = useState(false);

  useEffect(() => {
    if (!open) {
      setShowList(false);
      setError(null);
      setFiles([]);
      return;
    }
    let cancelled = false;
    setError(null);
    setSelected("");
    setLoading(true);
    setShowList(false);
    void (async () => {
      try {
        const tokenRes = await fetch("/api/portal/google-sheets/picker-token", { credentials: "include", cache: "no-store" });
        const tokenBody = (await tokenRes.json().catch(() => null)) as (PickerToken & { error?: string }) | null;
        if (!tokenRes.ok || !tokenBody?.accessToken) {
          throw new Error(tokenBody?.error || "Connect Google first.");
        }
        if (tokenBody.apiKey) {
          const official = await openOfficialPicker(tokenBody);
          if (cancelled) return;
          if (official) {
            await onPickRef.current(official);
            onCloseRef.current();
            return;
          }
          if (window.google?.picker) {
            onCloseRef.current();
            return;
          }
        }
        const filesRes = await fetch("/api/portal/google-sheets/files", { credentials: "include", cache: "no-store" });
        const filesBody = (await filesRes.json().catch(() => null)) as { files?: PickedSheet[]; error?: string } | null;
        if (!filesRes.ok) throw new Error(filesBody?.error || "Could not list spreadsheets.");
        if (!cancelled) {
          setFiles(filesBody?.files ?? []);
          setShowList(true);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not open Google.");
          setShowList(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open || !showList) return null;

  return (
    <PortalDialog
      open={open}
      onClose={onClose}
      title="Select a spreadsheet"
      primaryAction={{
        label: "Select",
        disabled: !selected || loading,
        onClick: () => {
          const file = files.find((row) => row.id === selected);
          if (!file) return;
          return Promise.resolve(onPick(file)).then(() => onClose());
        },
      }}
    >
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">…</p> : null}
      {!loading && !error
        ? files.map((file) => (
            <button
              key={file.id}
              type="button"
              data-attr="google-spreadsheet-pick"
              onClick={() => setSelected(file.id)}
              className={`flex w-full items-center rounded-xl px-3 py-2.5 text-left text-sm font-medium ${
                selected === file.id ? "bg-primary/10 text-foreground" : "text-foreground"
              }`}
            >
              {file.name}
            </button>
          ))
        : null}
    </PortalDialog>
  );
}
