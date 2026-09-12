"use client";

import { Check, ChevronDown, Clock, Mail, MessageSquare, Plus, Smartphone, Sparkles } from "lucide-react";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AxisAssistantSparkleIcon } from "@/components/portal/assistant-shared";
import { cn } from "@/lib/utils";

/**
 * The reply composer's one-row tools — ✦ (Draft with AI · Ask PropLane),
 * 🕒 schedule, and the channel menu — that sit between the reply field and
 * Send. They replaced three stacked rows of chips above the field: a reply
 * used to be four rows tall before a word was typed. Each tool is an icon
 * with a tooltip on a phone and gains its word from `md` up where there is
 * room for it.
 */

const TOOL_BTN =
  "inline-flex h-9 shrink-0 touch-manipulation items-center justify-center gap-1.5 rounded-xl border border-border bg-secondary px-0 text-muted outline-none transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-40 sm:h-10 md:h-[42px]";
const TOOL_BTN_ICON_ONLY = "w-9 sm:w-10 md:w-[42px]";
const TOOL_BTN_ACTIVE = "border-primary/35 bg-primary/10 text-primary hover:bg-primary/15";

export function InboxComposerAiMenu({
  onDraft,
  onAsk,
  disabled,
}: {
  /** Generate an approval-first draft from this conversation. */
  onDraft?: () => void;
  /** Open the PropLane Assistant beside the thread. */
  onAsk?: () => void;
  disabled?: boolean;
}) {
  if (!onDraft && !onAsk) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="AI"
          title="Draft with AI · Ask PropLane"
          disabled={disabled}
          className={cn(TOOL_BTN, TOOL_BTN_ICON_ONLY, "text-primary")}
          data-attr="inbox-composer-ai-menu"
        >
          <AxisAssistantSparkleIcon className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="min-w-[12rem]">
        {onDraft ? (
          <DropdownMenuItem onSelect={onDraft} data-attr="inbox-ai-draft-generate">
            <Sparkles strokeWidth={2.25} />
            Draft with AI
          </DropdownMenuItem>
        ) : null}
        {onAsk ? (
          <DropdownMenuItem onSelect={onAsk} data-attr="inbox-composer-ask-proplane">
            <AxisAssistantSparkleIcon className="h-4 w-4" />
            Ask PropLane
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function formatScheduledLabel(sendAt: string): string {
  const date = new Date(sendAt);
  if (Number.isNaN(date.getTime())) return "Scheduled";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function InboxComposerScheduleMenu({
  scheduleLater,
  onScheduleLaterChange,
  sendAt,
  onSendAtChange,
  disabled,
  scheduleDataAttr = "inbox-thread-schedule-later",
  sendAtDataAttr = "inbox-thread-schedule-at",
}: {
  scheduleLater: boolean;
  onScheduleLaterChange: (next: boolean) => void;
  sendAt: string;
  onSendAtChange: (next: string) => void;
  disabled?: boolean;
  scheduleDataAttr?: string;
  sendAtDataAttr?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={scheduleLater ? `Scheduled for ${formatScheduledLabel(sendAt)}` : "Schedule for later"}
          aria-pressed={scheduleLater}
          title={scheduleLater ? `Scheduled for ${formatScheduledLabel(sendAt)}` : "Schedule for later"}
          disabled={disabled}
          className={cn(TOOL_BTN, TOOL_BTN_ICON_ONLY, scheduleLater && TOOL_BTN_ACTIVE)}
          data-attr={scheduleDataAttr}
        >
          <Clock className="h-4 w-4" strokeWidth={2} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-[18rem] p-2">
        <DropdownMenuLabel className="px-1 pb-1 pt-0 text-[12px] font-semibold text-foreground">
          Schedule for later
        </DropdownMenuLabel>
        {/* Keystrokes stay in the field: the menu's typeahead would otherwise
            grab them and jump focus between items. */}
        <div className="px-1 pb-1" onKeyDown={(e) => e.stopPropagation()}>
          <Input
            type="datetime-local"
            className="w-full"
            value={sendAt}
            onChange={(e) => onSendAtChange(e.target.value)}
            aria-label="Send date and time"
            data-attr={sendAtDataAttr}
          />
        </div>
        <DropdownMenuItem
          onSelect={() => {
            onScheduleLaterChange(true);
            setOpen(false);
          }}
          data-attr="inbox-thread-schedule-confirm"
        >
          <Clock strokeWidth={2} />
          {scheduleLater ? "Keep this time" : "Send at this time"}
        </DropdownMenuItem>
        {scheduleLater ? (
          <DropdownMenuItem
            onSelect={() => {
              onScheduleLaterChange(false);
              setOpen(false);
            }}
            data-attr="inbox-thread-schedule-clear"
          >
            Send now instead
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ChannelId = "proplane" | "email" | "sms";

const CHANNEL_ICON: Record<ChannelId, typeof Mail> = {
  proplane: MessageSquare,
  email: Mail,
  sms: Smartphone,
};

/**
 * The channel a reply leaves on, as a compact menu with checkable rows —
 * In-app · Email · Text — so the reply field keeps its width on a phone.
 * More than one may be on (a reply can go by email AND text), and the last
 * one on cannot be switched off — a reply always has a channel.
 */
export function InboxComposerChannelMenu({
  viaEmail,
  viaSms,
  onViaEmailChange,
  onViaSmsChange,
  viaProplane = false,
  onViaProplaneChange,
  emailAvailable = true,
  smsAvailable = true,
  proplaneAvailable = false,
  onAddEmail,
  onAddPhone,
  sendingAs,
  disabled,
}: {
  viaEmail: boolean;
  viaSms: boolean;
  onViaEmailChange: (next: boolean) => void;
  onViaSmsChange: (next: boolean) => void;
  viaProplane?: boolean;
  onViaProplaneChange?: (next: boolean) => void;
  emailAvailable?: boolean;
  smsAvailable?: boolean;
  proplaneAvailable?: boolean;
  onAddEmail?: () => void;
  onAddPhone?: () => void;
  sendingAs?: { proplane?: string; email?: string; sms?: string };
  disabled?: boolean;
}) {
  const options: { id: ChannelId; label: string; disabled: boolean; reason?: string }[] = [
    ...(proplaneAvailable ? [{ id: "proplane" as const, label: "In-app", disabled: false }] : []),
    {
      id: "email",
      label: "Email",
      disabled: !emailAvailable,
      reason: emailAvailable ? undefined : "No email address on this conversation",
    },
    {
      id: "sms",
      label: "Text",
      disabled: !smsAvailable,
      reason: smsAvailable ? undefined : "Texting is off for this conversation",
    },
  ];

  const selected = new Set<ChannelId>([
    ...(viaProplane && proplaneAvailable ? (["proplane"] as const) : []),
    ...(viaEmail && emailAvailable ? (["email"] as const) : []),
    ...(viaSms && smsAvailable ? (["sms"] as const) : []),
  ]);
  if (selected.size === 0) {
    const fallback = options.find((o) => !o.disabled);
    if (fallback) selected.add(fallback.id);
  }

  const toggle = (id: ChannelId) => {
    const next = new Set(selected);
    if (next.has(id)) {
      if (next.size === 1) return; // a reply always has a channel
      next.delete(id);
    } else {
      next.add(id);
    }
    onViaProplaneChange?.(next.has("proplane"));
    onViaEmailChange(next.has("email"));
    onViaSmsChange(next.has("sms"));
  };

  const selectedOptions = options.filter((o) => selected.has(o.id));
  const label = selectedOptions.map((o) => o.label).join(" · ") || "Send via";
  const LeadIcon = CHANNEL_ICON[selectedOptions[0]?.id ?? "email"];

  const identity = (() => {
    const parts: string[] = [];
    if (selected.has("sms") && sendingAs?.sms) parts.push(sendingAs.sms);
    if (selected.has("email") && sendingAs?.email) parts.push(sendingAs.email);
    if (selected.has("proplane") && !parts.length && sendingAs?.proplane) parts.push(sendingAs.proplane);
    return parts.length ? `Sending as ${parts.join(" · ")}` : null;
  })();

  const addAction = !emailAvailable && onAddEmail
    ? { label: "Add an email address", onClick: onAddEmail, dataAttr: "inbox-reply-add-email" }
    : !smsAvailable && onAddPhone
      ? { label: "Add a phone number", onClick: onAddPhone, dataAttr: "inbox-reply-add-phone" }
      : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Send via: ${label}`}
          title={identity ?? label}
          disabled={disabled}
          className={cn(TOOL_BTN, "relative w-9 sm:w-10 md:w-auto md:px-3")}
          data-attr="inbox-reply-send-via"
        >
          <LeadIcon className="h-4 w-4" strokeWidth={2} aria-hidden />
          <span className="hidden max-w-[9rem] truncate text-[12.5px] font-semibold text-foreground md:inline">{label}</span>
          {selectedOptions.length > 1 ? (
            <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground md:hidden">
              {selectedOptions.length}
            </span>
          ) : null}
          <ChevronDown className="hidden h-3.5 w-3.5 md:inline" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="min-w-[14rem]" data-attr="inbox-reply-channel-picker">
        <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wide text-muted">Send via</DropdownMenuLabel>
        {options.map((option) => {
          const on = selected.has(option.id);
          const Icon = CHANNEL_ICON[option.id];
          return (
            <DropdownMenuItem
              key={option.id}
              disabled={option.disabled}
              title={option.reason}
              aria-checked={on}
              role="menuitemcheckbox"
              data-attr={`inbox-reply-channel-${option.id}`}
              onSelect={(e) => {
                e.preventDefault();
                toggle(option.id);
              }}
            >
              <Icon strokeWidth={2} />
              <span className="min-w-0 flex-1">
                <span className="block">{option.label}</span>
                {option.reason ? <span className="block text-[11px] font-normal text-muted">{option.reason}</span> : null}
              </span>
              <Check className={cn("!h-4 !w-4 !text-primary", on ? "opacity-100" : "opacity-0")} aria-hidden />
            </DropdownMenuItem>
          );
        })}
        {identity || addAction ? <DropdownMenuSeparator /> : null}
        {identity ? (
          <p className="px-3 py-1.5 text-[11px] text-muted" data-attr="inbox-reply-sending-as">
            {identity}
          </p>
        ) : null}
        {addAction ? (
          <DropdownMenuItem onSelect={addAction.onClick} data-attr={addAction.dataAttr} className="text-primary">
            <Plus className="!text-primary" />
            {addAction.label}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
