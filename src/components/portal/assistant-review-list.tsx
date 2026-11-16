"use client";

import { useEffect, useState } from "react";
import { FilterCollapsibleSection } from "@/components/portal/filter-field-lists";
import { fetchWithTimeout, PORTAL_READ_TIMEOUT_MS } from "@/lib/auth/fetch-with-timeout";
import { communicationThreadPath } from "@/lib/communication/deep-links";
import type { AssistantReviewRow } from "@/lib/assistant-review/model";

/** What a review row reads as: "Flagged: <reason>" or "Paused", on one plain line. */
export function assistantReviewRowLabel(row: Pick<AssistantReviewRow, "kind" | "reason">): string {
  if (row.kind === "pause") return "Assistant paused";
  return row.reason ? `Flagged: ${row.reason}` : "Flagged reply";
}

/** A text thread's key is not a route key; it reads as the number's last four digits and has no link. */
function rowTarget(row: AssistantReviewRow): { href: string | null; name: string } {
  const sms = /^sms:\d{6}(\d{4})$/.exec(row.threadKey);
  if (sms) return { href: null, name: `Text ...${sms[1]}` };
  return { href: communicationThreadPath("manager", row.threadKey), name: "Conversation" };
}

/**
 * Communication's Filter: "Assistant review" lists this workspace's open flagged replies and paused conversations. Manager
 * Communication only (it reads the active workspace's rows); the list is absent while it cannot be read.
 */
export function AssistantReviewFilterSection() {
  const [rows, setRows] = useState<AssistantReviewRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTimeout("/api/portal/assistant-review?view=list", { credentials: "include", cache: "no-store" }, PORTAL_READ_TIMEOUT_MS);
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as { rows?: AssistantReviewRow[] } | null;
        if (!cancelled && Array.isArray(body?.rows)) setRows(body.rows);
      } catch {
        /* no review list for this viewer */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  if (!rows) return null;
  return (
    <FilterCollapsibleSection
      sectionId="assistant-review"
      label="Assistant review"
      summary={rows.length ? String(rows.length) : "None"}
      empty={rows.length === 0}
      menuOptionCount={Math.max(1, rows.length)}
      dataAttr="communication-filter-assistant-review-trigger"
    >
      <ul className="flex flex-col py-1 text-sm" data-attr="communication-filter-assistant-review">
        {rows.length === 0 ? <li className="px-3 py-1.5 text-muted">Nothing to review</li> : null}
        {rows.map((row) => {
          const target = rowTarget(row);
          const line = `${target.name} · ${assistantReviewRowLabel(row)}`;
          return (
            <li key={row.id} className="px-3 py-1.5">
              {target.href ? (
                <a href={target.href} className="block truncate text-foreground hover:underline" data-attr="assistant-review-row">
                  {line}
                </a>
              ) : (
                <span className="block truncate text-foreground" data-attr="assistant-review-row">{line}</span>
              )}
            </li>
          );
        })}
      </ul>
    </FilterCollapsibleSection>
  );
}
