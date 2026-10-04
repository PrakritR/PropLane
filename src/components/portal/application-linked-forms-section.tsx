"use client";

import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { ReviewRow, ReviewSection } from "@/components/portal/pro-application-readonly-review";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { RECORD_ACTION_TRIGGER_ICON_CLASS } from "@/components/ui/record-action-menu";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useLinkedFormRequests } from "@/hooks/use-linked-form-requests";
import {
  isLinkedFormOpen,
  managerStatusLabel,
  waitingOnFormsFact,
  type LinkedFormRequestView,
} from "@/lib/application-linked-form-requests";
import {
  markLinkedFormNotNeededClient,
  mintLinkedFormShareUrl,
  sendLinkedFormByEmail,
} from "@/lib/linked-form-requests-client";

function feePaidText(request: LinkedFormRequestView): string | null {
  if (!request.feeCents || request.feeCents <= 0) return null;
  const amount = `$${(request.feeCents / 100).toFixed(2).replace(/\.00$/, "")}`;
  return request.feePaid ? `${amount} fee paid` : `${amount} fee`;
}

function LinkedFormRow({
  request,
  onChanged,
}: {
  request: LinkedFormRequestView;
  onChanged: () => void;
}) {
  const { showToast } = useAppUi();
  const [emailOpen, setEmailOpen] = useState(false);
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);
  const open = isLinkedFormOpen(request.status);
  const canShare = open && request.formKind === "application";
  const fee = feePaidText(request);

  const copyLink = async () => {
    const minted = await mintLinkedFormShareUrl(request.id);
    if (!minted.ok) {
      showToast(minted.error);
      return;
    }
    try {
      await navigator.clipboard.writeText(minted.url);
      showToast("Link copied");
    } catch {
      showToast(minted.url);
    }
    onChanged();
  };

  const send = async () => {
    if (sending) return;
    setSending(true);
    const result = await sendLinkedFormByEmail(request.id, to);
    setSending(false);
    if (!result.ok) {
      showToast(result.error ?? "The email could not be sent.");
      return;
    }
    showToast("Sent from your work email");
    setEmailOpen(false);
    setTo("");
    onChanged();
  };

  return (
    <li className="py-2.5" data-attr="application-linked-form-row">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold leading-5 text-foreground">{request.formLabel}</p>
          {request.sourceQuestionLabel ? (
            <p className="text-[13px] leading-5 text-muted">
              {`From “${request.sourceQuestionLabel}” = ${request.sourceAnswerLabel || "answered"}`}
            </p>
          ) : null}
          <p className="text-[13px] leading-5 text-foreground">
            {managerStatusLabel(request)}
            {fee ? <span className="text-muted">{` · ${fee}`}</span> : null}
          </p>
        </div>
        {open ? (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger
              type="button"
              aria-label={`Actions for ${request.formLabel}`}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-attr="application-linked-form-menu"
            >
              <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canShare ? (
                <DropdownMenuItem data-attr="application-linked-form-copy-link" onSelect={() => void copyLink()}>
                  Copy link
                </DropdownMenuItem>
              ) : null}
              {canShare ? (
                <DropdownMenuItem data-attr="application-linked-form-send" onSelect={() => setEmailOpen(true)}>
                  Send from work email
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                data-attr="application-linked-form-not-needed"
                onSelect={() => {
                  void (async () => {
                    const result = await markLinkedFormNotNeededClient(request.id);
                    if (!result.ok) showToast(result.error ?? "Could not update this form.");
                    onChanged();
                  })();
                }}
              >
                Mark not needed
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {emailOpen ? (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center" data-attr="application-linked-form-send-row">
          <Input
            type="email"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            placeholder="Email address"
            aria-label="Email address to send the link to"
          />
          <Button type="button" className="shrink-0" onClick={() => send()} disabled={!to.includes("@")}>
            Send
          </Button>
          <Button type="button" variant="ghost" className="shrink-0" onClick={() => setEmailOpen(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The manager's record of every form the template's rules owed on one application: where each came from, where
 * it stands, and what was paid. Draws nothing when the application owes no forms.
 */
export function ApplicationLinkedFormsSection({ applicationId }: { applicationId: string }) {
  const { requests, loading, reload } = useLinkedFormRequests(applicationId);
  if (loading || requests.length === 0) return null;
  const waiting = waitingOnFormsFact(requests);
  return (
    <ReviewSection title="Linked forms" data-attr="application-linked-forms">
      {waiting ? <ReviewRow k="Status" v={waiting} /> : null}
      <ul className="divide-y divide-border/60">
        {requests.map((request) => (
          <LinkedFormRow key={request.id} request={request} onChanged={() => void reload()} />
        ))}
      </ul>
    </ReviewSection>
  );
}
