"use client";

/**
 * Message a whole house, the compose-sheet half: the people it reaches (read from the server, never trusted
 * from the picker), the per-channel tally shown before Send, and the summary sheet after. Sending itself is the
 * modal's: one copy per person through `/api/portal/send-inbox-message` (see `fanOutHouseSend`).
 */
import { useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";
import { ConfirmRows, PortalDialog } from "@/components/portal/portal-dialog";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import {
  houseLackLine,
  housePersonResultLine,
  tallyHouseChannels,
  type HousePersonResult,
  type HouseRecipient,
  type HouseSendVia,
} from "@/lib/house-message-recipients";

export type HouseRecipientsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; people: HouseRecipient[]; excludedGuests: number };

/**
 * Loads the current residents of the picked houses, ONCE per pick. The route answers with everyone living
 * there and flags the short-stay guests, so the guest checkbox filters the answer in place rather than
 * re-running each house's occupancy snapshot every time it is toggled.
 */
export function useHouseRecipients(propertyIds: readonly string[], includeGuests: boolean, enabled: boolean): HouseRecipientsState {
  const [loaded, setLoaded] = useState<HouseRecipientsState>({ status: "idle" });
  const key = propertyIds.join(",");
  useEffect(() => {
    if (!enabled || propertyIds.length === 0) {
      setLoaded({ status: "idle" });
      return;
    }
    let active = true;
    setLoaded({ status: "loading" });
    void Promise.all(
      propertyIds.map(async (propertyId) => {
        const res = await fetch(`/api/portal/house-recipients?propertyId=${encodeURIComponent(propertyId)}`, {
          credentials: "include",
          cache: "no-store",
        });
        const data = (await res.json().catch(() => ({}))) as { people?: HouseRecipient[]; excludedGuests?: number; error?: string };
        if (!res.ok) throw new Error(data.error || "Could not load who lives there.");
        return data;
      }),
    )
      .then((all) => {
        if (!active) return;
        const seen = new Set<string>();
        const people: HouseRecipient[] = [];
        for (const data of all) {
          for (const person of data.people ?? []) {
            if (seen.has(person.id)) continue;
            seen.add(person.id);
            people.push(person);
          }
        }
        setLoaded({ status: "ready", people, excludedGuests: people.filter((person) => person.guest).length });
      })
      .catch((error: unknown) => {
        if (active) setLoaded({ status: "error", message: error instanceof Error ? error.message : "Could not load who lives there." });
      });
    return () => {
      active = false;
    };
    // `key` is the stable identity of propertyIds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);
  return useMemo(() => {
    if (loaded.status !== "ready" || includeGuests) return loaded;
    const people = loaded.people.filter((person) => !person.guest);
    return { status: "ready", people, excludedGuests: loaded.people.length - people.length };
  }, [loaded, includeGuests]);
}

/** Text 2 of 5 / Email 4 of 5 / App 5 of 5, one amber line for who lacks a phone or real email, and the guest checkbox. */
export function HouseMessageTally({
  state,
  via,
  includeGuests,
  onIncludeGuests,
}: {
  state: HouseRecipientsState;
  via: HouseSendVia;
  includeGuests: boolean;
  onIncludeGuests: (next: boolean) => void;
}) {
  const [showWho, setShowWho] = useState(false);
  if (state.status === "idle") return null;
  if (state.status === "loading") {
    return (
      <div role="status" className="text-sm text-muted" data-attr="house-message-loading">
        Loading who lives there…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <p role="alert" className="text-sm font-medium text-danger" data-attr="house-message-error">
        {state.message}
      </p>
    );
  }
  const tally = tallyHouseChannels(state.people, via);
  const lack = houseLackLine(tally);
  const lacking = [
    ...tally.missingPhone.map((person) => ({ person, what: "no phone" })),
    ...tally.missingEmail.map((person) => ({ person, what: "no real email" })),
  ];
  const rows: Array<{ label: string; value: string }> = [];
  if (tally.sms) rows.push({ label: "Text", value: `${tally.sms.reached} of ${tally.sms.total}` });
  if (tally.email) rows.push({ label: "Email", value: `${tally.email.reached} of ${tally.email.total}` });
  rows.push({ label: "App", value: `${tally.app.reached} of ${tally.app.total}` });
  return (
    <div className="space-y-2" data-attr="house-message-tally">
      <ConfirmRows rows={rows} />
      {lack ? (
        <div className="flex items-center justify-between gap-2" data-attr="house-message-lack">
          <p className="text-sm font-medium text-amber-700">{lack}</p>
          <PortalIconAction
            icon={Users}
            label="See who"
            active={showWho}
            onClick={() => setShowWho((open) => !open)}
            data-attr="house-message-see-who"
          />
        </div>
      ) : null}
      {showWho && lacking.length > 0 ? (
        <ul className="divide-y divide-border/70 text-sm" data-attr="house-message-lack-list">
          {lacking.map(({ person, what }) => (
            <li key={`${person.id}:${what}`} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate text-foreground">{person.name}</span>
              <span className="shrink-0 text-muted">{what}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <label className="flex min-h-11 items-center gap-2 text-sm" data-attr="house-message-include-guests">
        <input type="checkbox" checked={includeGuests} onChange={(event) => onIncludeGuests(event.target.checked)} />
        <span>Include short-stay guests</span>
      </label>
    </div>
  );
}

/** The sheet after sending: every person with the result per channel. Full screen on a phone. */
export function HouseSendSummaryDialog({
  open,
  houseLabel,
  results,
  onDone,
}: {
  open: boolean;
  houseLabel: string;
  results: HousePersonResult[];
  onDone: () => void;
}) {
  const sent = results.filter((result) => result.ok).length;
  return (
    <PortalDialog
      open={open}
      title={`Sent to ${sent} ${sent === 1 ? "person" : "people"}${houseLabel ? ` · ${houseLabel}` : ""}`}
      onClose={onDone}
      secondaryAction={null}
      primaryAction={{ label: "Done", onClick: onDone, dataAttr: "house-message-summary-done" }}
      dataAttr="house-message-summary"
    >
      <ul className="divide-y divide-border/70 text-sm" data-attr="house-message-summary-list">
        {results.map((result) => (
          <li key={result.id} className="flex items-start justify-between gap-3 py-2.5">
            <span className="min-w-0 truncate font-medium text-foreground">{result.name}</span>
            <span className={`min-w-0 text-right ${result.ok ? "text-muted" : "text-danger"}`}>{housePersonResultLine(result)}</span>
          </li>
        ))}
      </ul>
    </PortalDialog>
  );
}
