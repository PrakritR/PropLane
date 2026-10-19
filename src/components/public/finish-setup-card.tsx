"use client";

import { useState } from "react";
import { CodeInput, DoorButton, DoorShell } from "@/components/public/phone-bound-link-ui";
import { PhoneNumberField } from "@/components/ui/phone-number-field";

/**
 * The page behind a "finish setup" link: text a code to the phone, enter it, then ONE explicit button
 * into the portal. Nothing here redirects on its own (docs/agents/manager-account-creation.md).
 */
type Step = "phone" | "code" | "done" | "waitlisted";

async function post(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, status: 0, data: { error: "Could not reach PropLane. Check your connection." } };
  }
}

export function FinishSetupCard({ token, kind, boundPhoneLastFour }: { token: string; kind: "landlord" | "vendor"; boundPhoneLastFour: string | null }) {
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [error, setError] = useState("");
  const [portalHref, setPortalHref] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/api/start/${encodeURIComponent(token)}`;

  const send = async () => {
    setError("");
    setBusy(true);
    const result = await post(`${base}/send`, boundPhoneLastFour ? {} : { phone });
    setBusy(false);
    const id = typeof result.data.challengeId === "string" ? result.data.challengeId : "";
    if (result.ok && id) {
      setChallengeId(id);
      setCode("");
      setStep("code");
    } else setError(typeof result.data.error === "string" ? result.data.error : "Could not send a code.");
  };

  const verify = async () => {
    setError("");
    setBusy(true);
    const verified = await post("/api/auth/phone/verify", { challengeId, code });
    if (!verified.ok) {
      setBusy(false);
      setError("That code did not work.");
      return;
    }
    const done = await post(`${base}/complete`, {});
    setBusy(false);
    if (done.ok && typeof done.data.portalHref === "string") {
      setPortalHref(done.data.portalHref);
      setStep("done");
    } else if (done.status === 202) setStep("waitlisted");
    else setError(typeof done.data.error === "string" ? done.data.error : "Could not finish setup.");
  };

  if (step === "done") {
    return (
      <DoorShell dataAttr="finish-setup" title={kind === "vendor" ? "Your vendor profile is started" : "Your property account is ready"}>
        <DoorButton dataAttr="finish-setup-go" onClick={() => window.location.assign(portalHref)}>
          {kind === "vendor" ? "Go to your vendor portal" : "Go to your portal"}
        </DoorButton>
      </DoorShell>
    );
  }
  if (step === "waitlisted") {
    return (
      <DoorShell dataAttr="finish-setup" title="You are on the list">
        <p className="ps-door-line" data-attr="finish-setup-waitlisted">We will text you the moment a spot opens.</p>
      </DoorShell>
    );
  }

  return (
    <DoorShell dataAttr="finish-setup" title={kind === "vendor" ? "Finish your vendor profile" : "Finish setup"} size="h1">
      {step === "phone" ? (
        <>
          {boundPhoneLastFour ? (
            <ul className="ps-facts">
              <li>
                <span>Number</span>
                <span data-attr="finish-setup-phone">Ending {boundPhoneLastFour}</span>
              </li>
            </ul>
          ) : (
            <PhoneNumberField value={phone} onChange={setPhone} dataAttr="finish-setup-phone-input" />
          )}
          <DoorButton disabled={busy || (!boundPhoneLastFour && phone.length < 8)} dataAttr="finish-setup-send" onClick={send}>
            Text me a code
          </DoorButton>
        </>
      ) : (
        <>
          <CodeInput
            value={code}
            onChange={setCode}
            onEnter={() => {
              if (code.length === 6) void verify();
            }}
            dataAttr="finish-setup-code-input"
          />
          <DoorButton disabled={busy || code.length !== 6} dataAttr="finish-setup-verify" onClick={verify}>
            Verify
          </DoorButton>
          <DoorButton tone="text" dataAttr="finish-setup-resend" onClick={send}>
            Send a new code
          </DoorButton>
        </>
      )}
      {error ? (
        <p className="ps-error" role="alert" data-attr="finish-setup-error">
          {error}
        </p>
      ) : null}
    </DoorShell>
  );
}
