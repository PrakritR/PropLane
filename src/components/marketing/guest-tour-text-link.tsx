"use client";

import Link from "next/link";
import { useState } from "react";

/**
 * After a guest tour (no account), the one primary way to an account when the renter ticked the SMS box: a texted
 * single-use link to the number on the request. Opening it on that phone proves the phone, creates (or signs into) the
 * resident account and links this tour so it shows under Tour. The emailed link stays one tap away, and none of it
 * blocks the tour: it is already filed.
 */
export function GuestTourTextLink({
  inquiryId,
  createAccountHref,
  signInHref,
}: {
  inquiryId: string;
  createAccountHref: string;
  signInHref: string;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");

  const send = async () => {
    setState("sending");
    setError("");
    try {
      const res = await fetch("/api/public/guest-signup-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ kind: "tour", tourInquiryId: inquiryId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setState("sent");
        return;
      }
      setError(data.error ?? "We could not text that number. Use email instead.");
    } catch {
      setError("Could not reach PropLane. Check your connection.");
    }
    setState("idle");
  };

  return (
    <div className="ps-j-sect" data-attr="tour-success-text-link">
      <h3 className="ps-h3">Create an account to see your tour in PropLane</h3>
      <div className="ps-j-btn-row">
        <button type="button" className="ps-btn ps-btn-blue" disabled={state !== "idle"} onClick={() => void send()} data-attr="tour-success-text-link-send">
          {state === "sending" ? "Sending…" : "Text me a link"}
        </button>
        <Link href={createAccountHref} data-attr="tour-success-create-account" className="ps-btn ps-btn-line">
          Use email
        </Link>
        <Link href={signInHref} data-attr="tour-success-sign-in" className="ps-btn ps-btn-line">
          Sign in
        </Link>
      </div>
      {state === "sent" ? <p role="status" data-attr="tour-success-text-link-sent">Check your phone for your link.</p> : null}
      {error ? <p className="ps-error" role="alert" data-attr="tour-success-text-link-error">{error}</p> : null}
    </div>
  );
}
