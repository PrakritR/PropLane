"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { fetchGroupLeaderLinkPreview } from "@/lib/rental-application/group-leader-link-client";
import type { GroupLeaderLinkOk } from "@/lib/rental-application/group-leader-link";

export function GroupLeaderAppIdField({
  value,
  onChange,
  error,
  onResolved,
  suppressError = false,
}: {
  value: string;
  onChange: (next: string) => void;
  error?: string;
  onResolved?: (preview: GroupLeaderLinkOk | null) => void;
  /** When a parent row (e.g. ApplyFieldRow) renders the form validation error. */
  suppressError?: boolean;
}) {
  // A parent commonly supplies an inline callback that patches the form. Its
  // identity must not restart validation, or each result triggers another request.
  const onResolvedRef = useRef(onResolved);
  useEffect(() => { onResolvedRef.current = onResolved; }, [onResolved]);
  const [checking, setChecking] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewOk, setPreviewOk] = useState<GroupLeaderLinkOk | null>(null);

  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length < 4) {
      setChecking(false);
      setPreviewError(null);
      setPreviewOk(null);
      onResolvedRef.current?.(null);
      return;
    }

    let cancelled = false;
    setChecking(true);
    const timer = window.setTimeout(() => {
      void fetchGroupLeaderLinkPreview(trimmed).then((result) => {
        if (cancelled) return;
        setChecking(false);
        if (result.ok) {
          setPreviewOk(result);
          setPreviewError(null);
          onResolvedRef.current?.(result);
        } else {
          setPreviewOk(null);
          setPreviewError(result.message);
          onResolvedRef.current?.(null);
        }
      });
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [value]);

  const showError = error || previewError;
  const displayError = suppressError ? previewError : showError;

  return (
    <div className="space-y-2">
      <Input
        id="groupLeaderAppId"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="PROPLANE-…"
        autoComplete="off"
        className={showError ? "border-red-400 ring-2 ring-red-100" : ""}
      />
      {checking ? <p className="text-xs text-muted">Checking that application…</p> : null}
      {!checking && previewOk ? (
        <p className="text-xs font-medium text-emerald-800 [html[data-theme=dark]_&]:text-emerald-300">
          Linked to {previewOk.organizerFirstName ? `${previewOk.organizerFirstName}'s` : "the organizer's"} group
          {previewOk.groupSize != null ? ` (${previewOk.groupSize} people)` : ""}.
        </p>
      ) : null}
      {displayError ? <p className="text-xs font-medium text-red-600">{displayError}</p> : null}
    </div>
  );
}
