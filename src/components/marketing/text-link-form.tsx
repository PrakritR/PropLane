"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function TextLinkForm() {
  const id = useId();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  // After the first submit a code is texted to the number; the link follows once it is entered.
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const fields = new FormData(event.currentTarget);
    const phone = codeSentTo ?? String(fields.get("phone") ?? "");
    inFlight.current = true;
    setPending(true);
    setStatus(null);
    try {
      const response = await fetch("/api/public/text-demo-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(codeSentTo !== null
          ? { phone, action: "verify", otp: String(fields.get("otp") ?? "") }
          : { phone, consent: fields.get("consent") === "on" }),
        signal: AbortSignal.timeout(45_000),
      });
      const result = await response.json();
      if (response.ok && result.codeSent === true) {
        setCodeSentTo(phone);
        setStatus({ text: "We texted you a code. Enter it to get the link.", error: false });
      } else if (!response.ok || result.ok !== true) {
        setStatus({ text: response.status === 400 && codeSentTo !== null ? "That code did not work." : result.deliveryUnknown === true
          ? "Delivery isn't confirmed. Check your phone or view the dashboard."
          : response.status === 429 ? "Please try again later, or view the dashboard here." : "We couldn't send the text. View the dashboard here instead.", error: true });
      } else {
        setCodeSentTo(null);
        setStatus({ text: "Text sent. Check your phone.", error: false });
      }
    } catch {
      setStatus({ text: "Delivery isn't confirmed. Check your phone or view the dashboard.", error: true });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Text me a link" className="w-full max-w-sm space-y-3" data-attr="home-text-link-form">
      <label htmlFor={`${id}-phone`} className="block text-sm font-medium">Text me a link</label>
      <div className="flex gap-2">
        <Input id={`${id}-phone`} name="phone" type="tel" autoComplete="tel" required maxLength={40}
          placeholder="Phone number" disabled={pending || codeSentTo !== null} className="min-h-11 min-w-0 flex-1"
          aria-describedby={`${id}-consent`} data-attr="home-text-link-phone" />
        <Button type="submit" loading={pending} className="shrink-0 lg:min-h-11" data-attr="home-text-link-send">Send link</Button>
      </div>
      {codeSentTo !== null ? (
        <Input name="otp" inputMode="numeric" autoComplete="one-time-code" required maxLength={6} pattern="\d{6}"
          aria-label="Code" placeholder="6-digit code" disabled={pending} className="min-h-11" data-attr="home-text-link-code" />
      ) : null}
      <label htmlFor={`${id}-checkbox`} id={`${id}-consent`} className="flex min-h-11 cursor-pointer items-start gap-2 text-left text-xs leading-5 text-muted-foreground">
        <input id={`${id}-checkbox`} name="consent" type="checkbox" required={codeSentTo === null} disabled={pending || codeSentTo !== null}
          className="mt-1 size-4 shrink-0 accent-primary" data-attr="home-text-link-consent" />
        <span>I agree to receive one text from PropLane with a link. Message and data rates may apply. Reply STOP to opt out.</span>
      </label>
      {status ? <p role={status.error ? "alert" : "status"} className="text-sm" aria-live="polite">{status.text}</p> : null}
    </form>
  );
}
