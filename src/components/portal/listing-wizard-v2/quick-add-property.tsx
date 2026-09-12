"use client";

/**
 * Quick Add: getting a property into PropLane in under a minute.
 *
 * The insight this is built on is that two different jobs were wearing one
 * costume. "Add my property so I can start working" and "write a great public
 * listing" are not the same task, do not happen at the same time, and do not
 * deserve the same screen. Fusing them is why adding a property felt like filing
 * taxes: seventeen questions, six steps, and a dense form standing between a
 * manager and a rentable unit.
 *
 * So the two are split. This flow asks the FOUR things without which a property
 * cannot exist at all — what it is, where it is, how it is let, and what it
 * costs — one question to a screen, and then gets out of the way with the
 * property already created. Bathrooms, shared spaces, fees, amenities, photos
 * and the rest are not gone; they are optional, they live in the full editor,
 * and they can be done later or never.
 *
 * Every screen here follows the same three rules:
 *
 * - **One decision per screen.** Nothing else competes for the eye.
 * - **The answer is a target, not a field.** A property type is six cards, not a
 *   dropdown; whole-place versus by-the-room is two cards, not a checkbox. A
 *   manager on a phone should never have to open a select.
 * - **Nothing is asked twice.** What this collects is stamped on the submission
 *   and the editor reads it; the editor never re-asks it.
 *
 * It writes the SAME `ManagerListingSubmissionV1` the editor writes, through the
 * same persistence, so a property made here is the same row the long wizard
 * would have produced and opens in the editor for the rest.
 */

import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Building2,
  Check,
  Home,
  Images,
  KeyRound,
  Layers,
  Minus,
  Plus,
  Send,
  Store,
  Warehouse,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ListingAddressAutocomplete } from "@/components/portal/listing-address-autocomplete";
import type { AddressSuggestion } from "@/lib/geocode-address";
import { sanitizeMoneyInput } from "@/lib/listing-form-inputs";
import {
  applyListingBedroomSlots,
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { cn } from "@/lib/utils";

/** What a finished Quick Add hands back, and what the caller does next. */
export type QuickAddNext = "publish" | "details" | "another" | "done";

type Screen = "type" | "address" | "model" | "rooms" | "rent" | "next";

type PropertyKind = {
  id: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  /** Buildings are let as whole units far more often than rooms. */
  suggestsWholePlace?: boolean;
};

/**
 * The six shapes a manager recognises their own property in.
 *
 * Worded as things rather than categories — "a house", not "Single-family
 * residential" — because a manager is matching a picture in their head, not
 * classifying an asset.
 */
const PROPERTY_KINDS: PropertyKind[] = [
  { id: "house", label: "A house", hint: "Standalone home", icon: Home },
  { id: "townhouse", label: "A townhouse", hint: "Attached or row home", icon: Layers },
  { id: "condo", label: "A condo", hint: "Owned unit in a building", icon: Building2 },
  { id: "duplex", label: "A small building", hint: "2–4 units", icon: Warehouse },
  { id: "apartment", label: "An apartment building", hint: "5 or more units", icon: Building2, suggestsWholePlace: true },
  { id: "other", label: "Something else", hint: "Mixed use, ADU, other", icon: Store },
];

const MAX_ROOMS = 20;

/* ─────────────────────────── shell ─────────────────────────── */

function QuickAddShell({
  step,
  total,
  onBack,
  onClose,
  title,
  subtitle,
  children,
  footer,
  wide = false,
}: {
  /** 1-based, for the progress bar. `0` hides it — the last screen is not a step. */
  step: number;
  total: number;
  onBack?: () => void;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-full w-full flex-col bg-[var(--pl-surface)] [html[data-theme=dark]_&]:bg-[var(--pl-surface)]">
      <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-4 sm:px-8">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            data-attr="quick-add-back"
            className="flex items-center gap-1.5 text-[13px] font-bold uppercase tracking-wide text-primary hover:underline"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Back
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={onClose}
          data-attr="quick-add-close"
          className="rounded-full px-3 py-1.5 text-[13px] font-bold text-muted hover:bg-accent/50 hover:text-foreground"
        >
          Save &amp; close
        </button>
      </div>

      <div className="flex flex-1 items-start justify-center px-4 pb-16 pt-2 sm:items-center sm:px-6 sm:pb-24">
        <div className={cn("w-full", wide ? "max-w-[760px]" : "max-w-[620px]")}>
          {step > 0 ? (
            <div className="mx-auto mb-6 flex max-w-[220px] items-center gap-1.5" aria-hidden>
              {Array.from({ length: total }, (_, i) => (
                <span
                  key={i}
                  className={cn(
                    "h-1 flex-1 rounded-full transition-colors",
                    i < step ? "bg-primary" : "bg-border",
                  )}
                />
              ))}
            </div>
          ) : null}
          <div className="rounded-3xl border border-border bg-card p-6 shadow-[0_18px_50px_-30px_rgba(8,9,11,0.35)] sm:p-9">
            <h1 className="text-center text-[26px] font-extrabold leading-tight tracking-tight text-foreground sm:text-[30px]">
              {title}
            </h1>
            {subtitle ? (
              <p className="mx-auto mt-2 max-w-[46ch] text-center text-[14px] leading-relaxed text-muted">{subtitle}</p>
            ) : null}
            <div className="mt-7">{children}</div>
            {footer ? <div className="mt-8 flex flex-col items-center gap-3">{footer}</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The one big button every screen advances with. */
function Continue({
  label = "Continue",
  disabled,
  onClick,
  dataAttr,
}: {
  label?: string;
  disabled?: boolean;
  onClick: () => void;
  dataAttr?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-attr={dataAttr ?? "quick-add-continue"}
      className="min-h-[52px] w-full max-w-[320px] rounded-full bg-primary px-8 text-[15px] font-extrabold uppercase tracking-wide text-white transition disabled:opacity-40"
    >
      {label}
    </button>
  );
}

/**
 * A choice as a target.
 *
 * Deliberately a big card and not a radio or a select option: the whole point of
 * this flow is that a manager answers by hitting something obvious, including on
 * a phone where a native select is a modal of its own.
 */
function PickCard({
  icon: Icon,
  label,
  hint,
  selected,
  onClick,
  dataAttr,
  tall = false,
}: {
  icon?: LucideIcon;
  label: string;
  hint?: string;
  selected: boolean;
  onClick: () => void;
  dataAttr?: string;
  tall?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      data-attr={dataAttr}
      className={cn(
        "flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 bg-card px-4 text-center transition",
        tall ? "py-7" : "py-5",
        selected
          ? "border-primary bg-primary/[0.06] shadow-[0_0_0_4px_var(--accent)]"
          : "border-border hover:border-primary/40 hover:bg-accent/30",
      )}
    >
      {Icon ? (
        <Icon
          className={cn("h-7 w-7", selected ? "text-primary" : "text-muted")}
          strokeWidth={1.6}
          aria-hidden
        />
      ) : null}
      <span className="text-[14.5px] font-bold leading-tight text-foreground">{label}</span>
      {hint ? <span className="text-[12.5px] leading-snug text-muted">{hint}</span> : null}
    </button>
  );
}

/* ─────────────────────────── the flow ─────────────────────────── */

export function QuickAddProperty({
  onCancel,
  onCreated,
  onOpenEditor,
  onPublishNow,
  onAddAnother,
  saving = false,
  /** Saves the submission and resolves true when it is safely on the server. */
  save,
}: {
  onCancel: () => void;
  /** Fired once the property exists, so the list behind can refresh. */
  onCreated?: (sub: ManagerListingSubmissionV1) => void;
  /** "Add photos and details" — hand this submission to the full editor. */
  onOpenEditor: (sub: ManagerListingSubmissionV1) => void;
  /** "Publish the listing" — publish what was collected, as it stands. */
  onPublishNow: (sub: ManagerListingSubmissionV1) => void;
  onAddAnother: () => void;
  saving?: boolean;
  /**
   * Resolves ok, or the server's own explanation of why not. The explanation
   * is shown as-is: a plan limit is not a connection problem, and a manager
   * told to "check your connection" for a quota they have hit will try again
   * forever.
   */
  save: (sub: ManagerListingSubmissionV1) => Promise<{ ok: true } | { ok: false; message: string }>;
}) {
  const [screen, setScreen] = useState<Screen>("type");
  const [kindId, setKindId] = useState("");
  const [address, setAddress] = useState("");
  const [picked, setPicked] = useState<AddressSuggestion | null>(null);
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [byRoom, setByRoom] = useState<boolean | null>(null);
  const [roomCount, setRoomCount] = useState(3);
  const [roomNames, setRoomNames] = useState<string[]>([]);
  const [wholeRent, setWholeRent] = useState("");
  const [roomRents, setRoomRents] = useState<string[]>([]);
  const [saved, setSaved] = useState<ManagerListingSubmissionV1 | null>(null);
  const [error, setError] = useState("");

  /** Room names are generated, then editable — nobody wants to type "Room A". */
  const namesFor = (count: number) =>
    Array.from({ length: count }, (_, i) => roomNames[i] ?? `Room ${String.fromCharCode(65 + i)}`);

  const steps: Screen[] = useMemo(
    () => (byRoom ? ["type", "address", "model", "rooms", "rent"] : ["type", "address", "model", "rent"]),
    [byRoom],
  );
  const stepIndex = steps.indexOf(screen);
  const stepNumber = stepIndex >= 0 ? stepIndex + 1 : 0;

  const goBack = () => {
    const i = steps.indexOf(screen);
    if (i > 0) setScreen(steps[i - 1]!);
  };

  function selectSuggestion(s: AddressSuggestion) {
    setPicked(s);
    setAddress(s.address || s.label);
    if (s.city) setCity(s.city);
    if (s.state) setState(s.state);
    if (s.zip) setZip(s.zip);
  }

  /** Everything this flow collected, as the submission every other surface reads. */
  function buildSubmission(): ManagerListingSubmissionV1 {
    const base = createDefaultListingSubmission();
    const names = namesFor(byRoom ? roomCount : 1);
    const seeded: ManagerListingSubmissionV1 = {
      ...base,
      address,
      city,
      state,
      zip,
      neighborhood: picked?.neighborhood || base.neighborhood,
      buildingName: base.buildingName || address,
      listingPropertyTypeId: kindId,
      listingPlaceCategoryId: byRoom ? "shared_home" : "entire_home",
      rentalModelStamp: byRoom ? "shared_home" : "entire_home",
      listingBedroomSlots: byRoom ? roomCount : 1,
      entireHomeMonthlyRent: byRoom ? undefined : Number(wholeRent.replace(/[^0-9.]/g, "")) || undefined,
    };
    const withRooms = applyListingBedroomSlots(seeded, byRoom ? roomCount : 1);
    const sub = withRooms.ok ? withRooms.sub : seeded;
    const rooms = (sub.rooms ?? []).map((room, i) => ({
      ...room,
      name: names[i] ?? room.name,
      monthlyRent: byRoom
        ? Number((roomRents[i] ?? "").replace(/[^0-9.]/g, "")) || 0
        : Number(wholeRent.replace(/[^0-9.]/g, "")) || 0,
    }));
    return normalizeManagerListingSubmissionV1({ ...sub, rooms });
  }

  async function finish() {
    setError("");
    const sub = buildSubmission();
    const result = await save(sub);
    if (!result.ok) {
      // The manager's answers stay on screen; a failed save must never look like
      // a finished one — and the reason is the server's, not a guess.
      setError(result.message);
      return;
    }
    setSaved(sub);
    onCreated?.(sub);
    setScreen("next");
  }

  /* ── 1 · what ── */
  if (screen === "type") {
    return (
      <QuickAddShell
        step={stepNumber}
        total={steps.length}
        onClose={onCancel}
        title="What are you adding?"
        subtitle="This only changes the words we use. You can change it later."
        wide
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {PROPERTY_KINDS.map((k) => (
            <PickCard
              key={k.id}
              icon={k.icon}
              label={k.label}
              hint={k.hint}
              selected={kindId === k.id}
              dataAttr={`quick-add-kind-${k.id}`}
              onClick={() => {
                setKindId(k.id);
                // The answer IS the action. Making a manager pick a card and then
                // press Continue asks them to confirm something they just did.
                setScreen("address");
                if (k.suggestsWholePlace && byRoom === null) setByRoom(false);
              }}
            />
          ))}
        </div>
      </QuickAddShell>
    );
  }

  /* ── 2 · where ── */
  if (screen === "address") {
    const ready = address.trim().length > 2;
    return (
      <QuickAddShell
        step={stepNumber}
        total={steps.length}
        onBack={goBack}
        onClose={onCancel}
        title="Where is it?"
        subtitle="Start typing and pick the match — we fill in the rest."
        footer={<Continue disabled={!ready} onClick={() => setScreen("model")} />}
      >
        <div className="space-y-4">
          <ListingAddressAutocomplete
            value={address}
            onChange={(next) => {
              setAddress(next);
              setPicked(null);
            }}
            onSelect={selectSuggestion}
            placeholder="142 Ash St"
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_100px_120px]">
            <Input aria-label="City" placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} />
            <Input
              aria-label="State"
              placeholder="State"
              maxLength={2}
              value={state}
              onChange={(e) => setState(e.target.value.toUpperCase())}
            />
            <Input
              aria-label="ZIP"
              placeholder="ZIP"
              inputMode="numeric"
              maxLength={5}
              value={zip}
              onChange={(e) => setZip(e.target.value.replace(/[^0-9]/g, ""))}
            />
          </div>
        </div>
      </QuickAddShell>
    );
  }

  /* ── 3 · how it is let ── */
  if (screen === "model") {
    return (
      <QuickAddShell
        step={stepNumber}
        total={steps.length}
        onBack={goBack}
        onClose={onCancel}
        title="How will you rent it?"
        subtitle="This is the one answer that changes everything after it — and the only one worth getting right now."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <PickCard
            icon={KeyRound}
            tall
            label="The whole place"
            hint="One lease, one rent, one resident household"
            selected={byRoom === false}
            dataAttr="quick-add-model-whole"
            onClick={() => {
              setByRoom(false);
              setScreen("rent");
            }}
          />
          <PickCard
            icon={Layers}
            tall
            label="By the room"
            hint="A lease and a rent per room, with shared spaces"
            selected={byRoom === true}
            dataAttr="quick-add-model-room"
            onClick={() => {
              setByRoom(true);
              setScreen("rooms");
            }}
          />
        </div>
      </QuickAddShell>
    );
  }

  /* ── 4 · how many rooms ── */
  if (screen === "rooms") {
    const names = namesFor(roomCount);
    return (
      <QuickAddShell
        step={stepNumber}
        total={steps.length}
        onBack={goBack}
        onClose={onCancel}
        title="How many rooms do you rent?"
        subtitle="We name them for you. Rename any of them now, or later."
        footer={<Continue onClick={() => setScreen("rent")} />}
      >
        <div className="flex items-center justify-center gap-6">
          <button
            type="button"
            aria-label="One fewer room"
            disabled={roomCount <= 1}
            onClick={() => setRoomCount((n) => Math.max(1, n - 1))}
            className="grid h-14 w-14 place-items-center rounded-full border-2 border-border text-foreground transition hover:border-primary hover:text-primary disabled:opacity-30"
          >
            <Minus className="h-5 w-5" aria-hidden />
          </button>
          <span className="min-w-[72px] text-center text-[52px] font-extrabold tabular-nums leading-none tracking-tight text-foreground">
            {roomCount}
          </span>
          <button
            type="button"
            aria-label="One more room"
            disabled={roomCount >= MAX_ROOMS}
            onClick={() => setRoomCount((n) => Math.min(MAX_ROOMS, n + 1))}
            className="grid h-14 w-14 place-items-center rounded-full border-2 border-border text-foreground transition hover:border-primary hover:text-primary disabled:opacity-30"
          >
            <Plus className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="mx-auto mt-7 grid max-w-[420px] gap-2">
          {names.map((name, i) => (
            <Input
              key={i}
              aria-label={`Name for room ${i + 1}`}
              value={name}
              onChange={(e) => {
                const next = [...namesFor(roomCount)];
                next[i] = e.target.value;
                setRoomNames(next);
              }}
            />
          ))}
        </div>
      </QuickAddShell>
    );
  }

  /* ── 5 · what it costs ── */
  if (screen === "rent") {
    const names = namesFor(byRoom ? roomCount : 1);
    const ready = byRoom
      ? names.some((_, i) => (roomRents[i] ?? "").trim())
      : Boolean(wholeRent.trim());
    return (
      <QuickAddShell
        step={stepNumber}
        total={steps.length}
        onBack={goBack}
        onClose={onCancel}
        title={byRoom ? "What does each room rent for?" : "What does it rent for?"}
        subtitle="A monthly figure is enough to start. Deposits, fees and lease types come later."
        footer={
          <>
            <Continue
              label={saving ? "Saving…" : "Create property"}
              disabled={!ready || saving}
              onClick={() => void finish()}
              dataAttr="quick-add-create"
            />
            {error ? <p className="text-[13px] font-bold text-[var(--danger)]">{error}</p> : null}
          </>
        }
      >
        {byRoom ? (
          <div className="mx-auto max-w-[440px] space-y-2.5">
            {names.map((name, i) => (
              <div key={i} className="grid grid-cols-[minmax(0,1fr)_140px] items-center gap-3">
                <span className="truncate text-[14px] font-bold text-foreground">{name}</span>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-muted">
                    $
                  </span>
                  <Input
                    aria-label={`Monthly rent for ${name}`}
                    className="pl-7"
                    inputMode="numeric"
                    placeholder="1,100"
                    value={roomRents[i] ?? ""}
                    onChange={(e) => {
                      const next = [...roomRents];
                      next[i] = sanitizeMoneyInput(e.target.value);
                      setRoomRents(next);
                    }}
                  />
                </div>
              </div>
            ))}
            {names.length > 1 && (roomRents[0] ?? "").trim() ? (
              <button
                type="button"
                data-attr="quick-add-fill-down"
                onClick={() => setRoomRents(names.map(() => roomRents[0] ?? ""))}
                className="text-[13px] font-bold text-primary hover:underline"
              >
                Use {`$${roomRents[0]}`} for every room
              </button>
            ) : null}
          </div>
        ) : (
          <div className="mx-auto max-w-[260px]">
            <div className="relative">
              <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[22px] font-bold text-muted">
                $
              </span>
              <input
                aria-label="Monthly rent"
                inputMode="numeric"
                autoFocus
                placeholder="2,400"
                value={wholeRent}
                onChange={(e) => setWholeRent(sanitizeMoneyInput(e.target.value))}
                className="h-16 w-full rounded-2xl border-2 border-border bg-card pl-10 pr-4 text-[28px] font-extrabold tabular-nums text-foreground outline-none focus:border-primary"
              />
            </div>
            <p className="mt-2 text-center text-[12.5px] text-muted">per month</p>
          </div>
        )}
      </QuickAddShell>
    );
  }

  /* ── 6 · what next ── */
  const label = saved?.buildingName?.trim() || saved?.address?.trim() || "Your property";
  return (
    <QuickAddShell step={0} total={steps.length} onClose={onCancel} title={`${label} is in.`} subtitle="What would you like to do next?">
      <div className="mx-auto grid max-w-[420px] gap-3">
        <NextAction
          icon={Send}
          label="Publish the listing"
          hint="Put it in front of renters now"
          dataAttr="quick-add-next-publish"
          onClick={() => saved && onPublishNow(saved)}
        />
        <NextAction
          icon={Images}
          label="Add photos and details"
          hint="Bathrooms, shared spaces, fees, amenities"
          dataAttr="quick-add-next-details"
          onClick={() => saved && onOpenEditor(saved)}
        />
        <NextAction
          icon={Home}
          label="Add another property"
          hint="Do this again for the next one"
          dataAttr="quick-add-next-another"
          onClick={onAddAnother}
        />
      </div>
      <div className="mt-6 text-center">
        <button
          type="button"
          onClick={onCancel}
          data-attr="quick-add-next-done"
          className="text-[13.5px] font-bold uppercase tracking-wide text-primary hover:underline"
        >
          Back to properties
        </button>
      </div>
    </QuickAddShell>
  );
}

function NextAction({
  icon: Icon,
  label,
  hint,
  onClick,
  dataAttr,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  onClick: () => void;
  dataAttr?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-attr={dataAttr}
      className="flex items-center gap-4 rounded-2xl border-2 border-border bg-card px-5 py-4 text-left transition hover:border-primary/50 hover:bg-accent/30"
    >
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent text-primary">
        <Icon className="h-5 w-5" strokeWidth={1.7} aria-hidden />
      </span>
      <span className="min-w-0">
        <b className="block text-[15px] font-bold text-foreground">{label}</b>
        <span className="block text-[12.5px] text-muted">{hint}</span>
      </span>
      <Check className="ml-auto h-4 w-4 shrink-0 text-transparent" aria-hidden />
    </button>
  );
}
