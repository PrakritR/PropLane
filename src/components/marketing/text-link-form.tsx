"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function TextLinkForm() {
  const id = useId();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const fields = new FormData(event.currentTarget);
    inFlight.current = true;
    setPending(true);
    setStatus(null);
    try {
      const response = await fetch("/api/public/text-demo-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: String(fields.get("phone") ?? ""), consent: fields.get("consent") === "on" }),
        signal: AbortSignal.timeout(45_000),
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) {
        setStatus({ text: result.deliveryUnknown === true
          ? "Delivery isn't confirmed. Check your phone or open the demo."
          : response.status === 429 ? "Please try again later, or open the demo here." : "We couldn't send the text. Open the demo here instead.", error: true });
      } else {
        setStatus({ text: "Text sent. Check your phone.", error: false });
      }
    } catch {
      setStatus({ text: "Delivery isn't confirmed. Check your phone or open the demo.", error: true });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Text me a demo link" className="w-full max-w-sm space-y-3" data-attr="home-text-link-form">
      <label htmlFor={`${id}-phone`} className="block text-sm font-medium">Text me a link</label>
      <div className="flex gap-2">
        <Input id={`${id}-phone`} name="phone" type="tel" autoComplete="tel" required maxLength={40}
          placeholder="Phone number" disabled={pending} className="min-h-11 min-w-0 flex-1"
          aria-describedby={`${id}-consent`} data-attr="home-text-link-phone" />
        <Button type="submit" loading={pending} className="shrink-0 lg:min-h-11" data-attr="home-text-link-send">Send link</Button>
      </div>
      <label htmlFor={`${id}-checkbox`} id={`${id}-consent`} className="flex min-h-11 cursor-pointer items-start gap-2 text-left text-xs leading-5 text-muted-foreground">
        <input id={`${id}-checkbox`} name="consent" type="checkbox" required disabled={pending}
          className="mt-1 size-4 shrink-0 accent-primary" data-attr="home-text-link-consent" />
        <span>I agree to receive one text from PropLane with a demo link. Message and data rates may apply. Reply STOP to opt out.</span>
      </label>
      {status ? <p role={status.error ? "alert" : "status"} className="text-sm" aria-live="polite">{status.text}</p> : null}
    </form>
  );
}
