"use client";

import { useState } from "react";
import { DoorButton, DoorShell } from "@/components/public/phone-bound-link-ui";

/**
 * The page behind a texted "Text me a link" (`/l/<token>`, a guest sign-in link). Opening it spends nothing, so a text
 * previewer or a double tap cannot burn it: the one button posts, the server spends the link, creates (or signs into)
 * the account for the phone it was texted to and returns where to go (the apply page, which claims the held application,
 * or the resident's Tour page).
 */
export function GuestSignupContinue({ token, kind, houseLabel, maskedPhone }: { token: string; kind: "apply" | "tour"; houseLabel: string; maskedPhone: string }) {
  const [error, setError] = useState("");

  const go = async () => {
    setError("");
    try {
      const res = await fetch(`/api/l/${encodeURIComponent(token)}/guest-signup`, { method: "POST", credentials: "same-origin" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; nextPath?: string };
      if (res.ok && typeof data.nextPath === "string" && data.nextPath.startsWith("/")) {
        window.location.assign(data.nextPath);
        return;
      }
      setError(data.error ?? "We could not finish that. Try again.");
    } catch {
      setError("Could not reach PropLane. Check your connection.");
    }
  };

  const title = kind === "tour" ? "See your tour" : "Finish your application";
  return (
    <DoorShell title={houseLabel ? `${title}: ${houseLabel}` : title} dataAttr="guest-signup-continue">
      <label className="ps-field">
        <span className="ps-label">Phone</span>
        <input className="ps-input" value={maskedPhone} readOnly aria-readonly="true" data-attr="guest-signup-phone" />
      </label>
      <DoorButton dataAttr="guest-signup-go" onClick={go}>
        Continue
      </DoorButton>
      {error ? <p className="ps-error" role="alert" data-attr="guest-signup-error">{error}</p> : null}
    </DoorShell>
  );
}
