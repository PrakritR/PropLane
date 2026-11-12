"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DoorButton, DoorShell } from "@/components/public/phone-bound-link-ui";
import type { OnboardingPrefill } from "@/lib/resident-onboarding-link/model";

/**
 * The text onboarding link's page, after the one-time code: one screen for the details, a second only when the
 * house has rules to accept. Everything PropLane already knows is filled in. The code already proved the phone, so
 * there is no password: the account signs in with this phone.
 */
export function ResidentOnboardingForm({ token, prefill }: { token: string; prefill: OnboardingPrefill }) {
  const router = useRouter();
  const hasRules = prefill.houseRules.trim().length > 0;
  const [screen, setScreen] = useState<"details" | "rules">("details");
  const [fullName, setFullName] = useState(prefill.fullName);
  const [email, setEmail] = useState(prefill.email);
  const [acceptRules, setAcceptRules] = useState(false);
  const [joinGroupText, setJoinGroupText] = useState(true);
  const [error, setError] = useState("");

  const submit = async () => {
    setError("");
    try {
      const res = await fetch(`/api/l/${encodeURIComponent(token)}/onboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ fullName, email, acceptRules, joinGroupText }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; nextPath?: string };
      if (res.ok && typeof data.nextPath === "string") {
        router.push(data.nextPath);
        return;
      }
      setError(data.error ?? "We could not finish that. Try again.");
    } catch {
      setError("Could not reach PropLane. Check your connection.");
    }
  };

  const title = prefill.houseLabel ? `Welcome to ${prefill.houseLabel}` : "Welcome";

  return (
    <DoorShell title={title} dataAttr="resident-onboarding">
      {screen === "details" ? (
        <>
          <label className="ps-field">
            <span className="ps-label">Full name</span>
            <input className="ps-input" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" data-attr="onboarding-name" />
          </label>
          <label className="ps-field">
            <span className="ps-label">Email</span>
            <input className="ps-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" data-attr="onboarding-email" />
          </label>
          {!hasRules ? (
            <label className="ps-check">
              <input type="checkbox" checked={joinGroupText} onChange={(e) => setJoinGroupText(e.target.checked)} data-attr="onboarding-group-text" />
              <span>Add me to the house group text</span>
            </label>
          ) : null}
          {hasRules ? (
            <DoorButton dataAttr="onboarding-continue" disabled={fullName.trim().length < 2} onClick={() => setScreen("rules")}>
              Continue
            </DoorButton>
          ) : (
            <DoorButton dataAttr="onboarding-finish" disabled={fullName.trim().length < 2} onClick={submit}>
              Finish
            </DoorButton>
          )}
        </>
      ) : (
        <>
          <div className="ps-rules" data-attr="onboarding-rules" style={{ maxHeight: "40vh", overflowY: "auto", whiteSpace: "pre-wrap" }}>
            {prefill.houseRules}
          </div>
          <label className="ps-check">
            <input type="checkbox" checked={acceptRules} onChange={(e) => setAcceptRules(e.target.checked)} data-attr="onboarding-accept-rules" />
            <span>I accept the house rules</span>
          </label>
          <label className="ps-check">
            <input type="checkbox" checked={joinGroupText} onChange={(e) => setJoinGroupText(e.target.checked)} data-attr="onboarding-group-text" />
            <span>Add me to the house group text</span>
          </label>
          <DoorButton dataAttr="onboarding-finish" disabled={!acceptRules} onClick={submit}>
            Finish
          </DoorButton>
          <DoorButton tone="text" dataAttr="onboarding-back" onClick={() => setScreen("details")}>
            Back
          </DoorButton>
        </>
      )}
      {error ? (
        <p className="ps-error" role="alert" data-attr="onboarding-error">
          {error}
        </p>
      ) : null}
    </DoorShell>
  );
}
