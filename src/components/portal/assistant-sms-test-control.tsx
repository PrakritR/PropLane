"use client";

import { MessageSquareText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PortalFormSingleSelect } from "@/components/portal/filter-field-lists";
import { useOptionalAssistantConversation } from "@/lib/axis-assistant/assistant-conversation-context";
import { usePortalAssistantConfig } from "@/lib/axis-assistant/portal-assistant-context";
import { currentSmsTestTurn } from "@/lib/axis-assistant/sms-test-turn-state";

const STAGE_LABELS = {
  prospect: "Prospect",
  submitted: "Application submitted",
  approved: "Approved resident",
} as const;

export function AssistantSmsTestControl() {
  const smsTest = usePortalAssistantConfig()?.smsTest;
  const { activeThreadId, lastSmsTestTurn } = useOptionalAssistantConversation();
  if (!smsTest) return null;

  const target = smsTest.targets.find((candidate) => candidate.listingId === smsTest.selectedTargetId);
  // A stage can change after an application submission. Only a response from
  // this target and session is current; a prior chat must not relabel the next one.
  const currentTurn = currentSmsTestTurn(lastSmsTestTurn, smsTest.selectedTargetId, activeThreadId);
  const stage = currentTurn?.stage ?? target?.stage;
  const canStart = smsTest.portal === "manager" || Boolean(target);

  return (
    <div className="shrink-0 border-b border-border/60 bg-foreground/[0.025] px-3 py-2" data-attr="assistant-sms-test-control">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <MessageSquareText className="h-3.5 w-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-foreground">
            {smsTest.active ? "SMS test active" : "Test the SMS assistant"}
          </p>
          <p className="truncate text-[11px] leading-4 text-muted">
            {smsTest.active
              ? smsTest.portal === "manager"
                ? "Manager or co-manager own-number scope"
                : `${stage ? STAGE_LABELS[stage] : "Stage checked each message"}${target ? ` · ${target.title}` : ""}`
              : "No phone number or carrier delivery needed"}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={smsTest.onToggle}
          disabled={smsTest.loading || (!smsTest.active && !canStart)}
          className="min-h-8 shrink-0 px-3 py-1.5 text-[11px]"
        >
          {smsTest.active ? "Exit test" : "Start test"}
        </Button>
      </div>

      {smsTest.portal === "resident" && !smsTest.active ? (
        <div className="mt-2">
          <PortalFormSingleSelect
            label="Listing to test"
            value={smsTest.selectedTargetId}
            onChange={smsTest.onSelectTarget}
            disabled={smsTest.loading}
            placeholder="Choose a listing…"
            options={smsTest.targets.map((candidate) => ({
              value: candidate.listingId,
              label: `${candidate.title}${candidate.address ? ` - ${candidate.address}` : ""}`,
            }))}
            dataAttr="assistant-sms-test-listing"
            labelClassName="sr-only"
          />
        </div>
      ) : null}

      {smsTest.loading ? <p className="mt-1 text-[11px] text-muted">Checking test access…</p> : null}
      {smsTest.error ? (
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-danger" role="alert">
          <span>{smsTest.error}</span>
          <button type="button" onClick={smsTest.onRetry} className="font-semibold underline underline-offset-2">
            Retry
          </button>
        </div>
      ) : null}
      {!smsTest.loading && !smsTest.error && smsTest.portal === "resident" && smsTest.targets.length === 0 ? (
        <p className="mt-1 text-[11px] text-muted">No eligible listings are available for this account.</p>
      ) : null}
      {smsTest.active && currentTurn?.effects.length ? (
        <div className="mt-2 rounded-lg border border-primary/15 bg-primary/[0.045] px-2.5 py-2" aria-live="polite">
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-primary">Test delivery evidence</p>
          <ul className="mt-1 space-y-1 text-[11px] leading-4 text-muted">
            {currentTurn.effects.map((effect, index) => (
              <li key={`${effect.kind}:${index}`}>
                <span className="font-medium text-foreground">{effect.status === "captured" ? "Captured" : "Refused"}:</span>{" "}
                {effect.summary}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
