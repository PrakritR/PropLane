"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { BOOK_DEMO_EVENT, BOOK_DEMO_NOTE, BOOK_DEMO_TOPIC } from "@/lib/marketing/public-contact";
import { MANAGED_SERVICE_TOPIC } from "@/lib/marketing/managed-service";
import { PUBLIC_SUPPORT_EMAIL } from "@/lib/marketing/public-contact";
import { SITE_BTN_PRIMARY } from "@/components/marketing/site/primitives";
import { cn } from "@/lib/utils";

/** The contact route this form files into (the same one the Contact page's "Send message" uses). */
export const MANAGED_SERVICE_FORM_ENDPOINT = "/api/public/contact-message";

const RENTAL_KINDS = [
  "Short-term (Airbnb-style)",
  "Rooms rented by the room",
  "Whole-home long-term lease",
  "Not sure yet",
] as const;

const FIELD =
  "w-full rounded-[10px] border border-[#d6d7d2] bg-white px-3.5 py-3 text-[15px] text-[#17181a] outline-none transition-[border-color,box-shadow] placeholder:text-[#7b8aa0] focus:border-[#2f5fd0] focus:ring-2 focus:ring-[#2f5fd0]/20";
const LABEL = "mb-1.5 block text-[13px] font-bold text-[#17181a]";

/** Turns the form into the plain-text message the existing contact route stores. Exported for tests. */
export function composeManagedServiceMessage(f: {
  phone: string;
  address: string;
  rooms: string;
  kind: string;
  note: string;
}): string {
  const lines = [
    "PropLane Managed inquiry",
    `Home: ${f.address.trim() || "not given"}`,
    `Rooms: ${f.rooms.trim() || "not given"}`,
    `Rental type: ${f.kind || "not given"}`,
    `Phone: ${f.phone.trim() || "not given"}`,
  ];
  if (f.note.trim()) lines.push("", f.note.trim());
  return lines.join("\n");
}

export function ManagedServiceForm({
  className,
  attrPrefix = "managed-form",
  variant = "full",
}: {
  className?: string;
  attrPrefix?: string;
  variant?: "full" | "swiss";
}) {
  const [homes, setHomes] = useState(1);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [rooms, setRooms] = useState("");
  const [kind, setKind] = useState("");
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [problem, setProblem] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);

  // Book a demo (the top bar, and every other "Book a demo" link) opens this form as a demo request: the Message is
  // prefilled and Name takes focus. Arriving from another page reads `?topic=`; on the homepage the link fires an event.
  useEffect(() => {
    if (variant !== "swiss") return;
    const open = () => {
      setNote((current) => current.trim() || BOOK_DEMO_NOTE);
      nameInput.current?.focus({ preventScroll: true });
    };
    let settle: number | undefined;
    if (new URLSearchParams(window.location.search).get("topic") === BOOK_DEMO_TOPIC) {
      open();
      // Arriving from another page, the browser's own #contact jump lands before the sections above it finish
      // laying out; bring the form into view once they have.
      settle = window.setTimeout(() => {
        nameInput.current?.closest("section")?.scrollIntoView({ block: "start" });
        nameInput.current?.focus({ preventScroll: true });
      }, 400);
    }
    window.addEventListener(BOOK_DEMO_EVENT, open);
    return () => {
      window.clearTimeout(settle);
      window.removeEventListener(BOOK_DEMO_EVENT, open);
    };
  }, [variant]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (state === "sending") return;
    if (!name.trim() || !email.includes("@")) {
      setProblem("Please enter your name and a valid email.");
      setState("error");
      return;
    }
    if (variant !== "swiss" && !address.trim()) {
      setProblem("Please tell us where the home is.");
      setState("error");
      return;
    }
    setState("sending");
    setProblem("");
    try {
      const res = await fetch(MANAGED_SERVICE_FORM_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          topic: MANAGED_SERVICE_TOPIC,
          body:
            variant === "swiss"
              ? `PropLane Managed inquiry\nNumber of homes: ${homes}${note.trim() ? `\n\n${note.trim()}` : ""}`
              : composeManagedServiceMessage({
                  phone,
                  address,
                  rooms,
                  kind,
                  note,
                }),
        }),
      });
      if (!res.ok) throw new Error("bad status");
      setState("sent");
    } catch {
      setProblem(
        `We could not send that. Please try again or email ${PUBLIC_SUPPORT_EMAIL}.`,
      );
      setState("error");
    }
  }

  if (state === "sent") {
    return (
      <div
        role="status"
        data-attr={`${attrPrefix}-sent`}
        className={cn(
          "rounded-2xl border border-[#d6d7d2] bg-white/90 p-8 text-center",
          className,
        )}
      >
        <p className="site-display text-[22px] font-bold tracking-tight text-[#17181a]">
          Thanks, we have it.
        </p>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">
          We will reply to {email.trim()} about your home.
        </p>
      </div>
    );
  }

  if (variant === "swiss")
    return (
      <form
        className={cn("swiss-inquiry", className)}
        data-attr={attrPrefix}
        onSubmit={submit}
      >
        <div className="swiss-field">
          <label htmlFor={`${attrPrefix}-name`}>Name</label>
          <input
            ref={nameInput}
            id={`${attrPrefix}-name`}
            autoComplete="name"
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="swiss-field">
          <label htmlFor={`${attrPrefix}-email`}>Email</label>
          <input
            id={`${attrPrefix}-email`}
            type="email"
            autoComplete="email"
            required
            maxLength={320}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="swiss-field">
          <label htmlFor={`${attrPrefix}-homes`}>Number of homes</label>
          <div className="swiss-stepper">
            <button
              type="button"
              aria-label="Fewer homes"
              disabled={homes <= 1}
              onClick={() => setHomes((n) => Math.max(1, n - 1))}
            >
              −
            </button>
            <input
              id={`${attrPrefix}-homes`}
              type="number"
              min={1}
              max={10000}
              inputMode="numeric"
              value={homes}
              onChange={(e) =>
                setHomes(
                  Math.min(10000, Math.max(1, Number(e.target.value) || 1)),
                )
              }
            />
            <button
              type="button"
              aria-label="More homes"
              disabled={homes >= 10000}
              onClick={() => setHomes((n) => Math.min(10000, n + 1))}
            >
              +
            </button>
          </div>
        </div>
        <div className="swiss-field">
          <label htmlFor={`${attrPrefix}-note`}>Message</label>
          <textarea
            id={`${attrPrefix}-note`}
            rows={4}
            maxLength={10000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {state === "error" && <p role="alert">{problem}</p>}
        <div className="swiss-form-footer">
          <button
            type="submit"
            data-attr={`${attrPrefix}-submit`}
            disabled={state === "sending"}
          >
            {state === "sending" ? "Sending…" : "Send"}
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </form>
    );

  return (
    <form
      onSubmit={submit}
      noValidate
      data-attr={attrPrefix}
      className={cn(
        "rounded-2xl border border-[#d6d7d2] bg-white/90 p-5 text-left shadow-[0_24px_60px_-34px_rgba(12,13,16,0.3)] sm:p-7",
        className,
      )}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${attrPrefix}-name`} className={LABEL}>
            Name *
          </label>
          <input
            id={`${attrPrefix}-name`}
            className={FIELD}
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Smith"
          />
        </div>
        <div>
          <label htmlFor={`${attrPrefix}-email`} className={LABEL}>
            Email *
          </label>
          <input
            id={`${attrPrefix}-email`}
            type="email"
            className={FIELD}
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane@example.com"
          />
        </div>
        <div>
          <label htmlFor={`${attrPrefix}-phone`} className={LABEL}>
            Phone
          </label>
          <input
            id={`${attrPrefix}-phone`}
            type="tel"
            className={FIELD}
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <div>
          <label htmlFor={`${attrPrefix}-rooms`} className={LABEL}>
            Rooms in the home
          </label>
          <input
            id={`${attrPrefix}-rooms`}
            inputMode="numeric"
            className={FIELD}
            value={rooms}
            onChange={(e) => setRooms(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={`${attrPrefix}-address`} className={LABEL}>
            Where is the home? *
          </label>
          <input
            id={`${attrPrefix}-address`}
            className={FIELD}
            autoComplete="street-address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Street and city"
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={`${attrPrefix}-kind`} className={LABEL}>
            How is it rented, or how do you want to rent it?
          </label>
          <select
            id={`${attrPrefix}-kind`}
            className={FIELD}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">Choose one</option>
            {RENTAL_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={`${attrPrefix}-note`} className={LABEL}>
            Anything else we should know
          </label>
          <textarea
            id={`${attrPrefix}-note`}
            rows={4}
            className={cn(FIELD, "resize-y leading-relaxed")}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>
      {state === "error" && problem ? (
        <p
          role="alert"
          className="mt-4 text-[14px] font-semibold text-[#b91c1c]"
        >
          {problem}
        </p>
      ) : null}
      <button
        type="submit"
        data-attr={`${attrPrefix}-submit`}
        disabled={state === "sending"}
        className={cn(
          SITE_BTN_PRIMARY,
          "mt-5 w-full disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        {state === "sending" ? "Sending…" : "Talk to us"}
      </button>
    </form>
  );
}
