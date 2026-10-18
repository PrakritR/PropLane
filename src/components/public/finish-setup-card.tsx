"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[55vh] w-full max-w-[460px] flex-col justify-center px-4 py-12" data-attr="finish-setup">
      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        <div className="mt-5 flex flex-col gap-4">{children}</div>
      </div>
    </div>
  );
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
      <Shell title={kind === "vendor" ? "Your vendor profile is started" : "Your property account is ready"}>
        <Button type="button" className="w-full rounded-full" data-attr="finish-setup-go" onClick={() => window.location.assign(portalHref)}>
          {kind === "vendor" ? "Go to your vendor portal" : "Go to your portal"}
        </Button>
      </Shell>
    );
  }
  if (step === "waitlisted") {
    return (
      <Shell title="You are on the list">
        <p className="text-sm text-foreground" data-attr="finish-setup-waitlisted">We will text you the moment a spot opens.</p>
      </Shell>
    );
  }

  return (
    <Shell title={kind === "vendor" ? "Finish your vendor profile" : "Finish setup"}>
      {step === "phone" ? (
        <>
          {boundPhoneLastFour ? (
            <p className="text-sm text-foreground" data-attr="finish-setup-phone">Number ending {boundPhoneLastFour}</p>
          ) : (
            <PhoneNumberField value={phone} onChange={setPhone} dataAttr="finish-setup-phone-input" />
          )}
          <Button type="button" className="w-full rounded-full" disabled={busy || (!boundPhoneLastFour && phone.length < 8)} data-attr="finish-setup-send" onClick={send}>
            Text me a code
          </Button>
        </>
      ) : (
        <>
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            placeholder="6-digit code"
            aria-label="Code"
            data-attr="finish-setup-code-input"
            className="text-center text-lg tracking-[0.35em]"
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && code.length === 6) void verify();
            }}
          />
          <Button type="button" className="w-full rounded-full" disabled={busy || code.length !== 6} data-attr="finish-setup-verify" onClick={() => verify()}>
            Continue
          </Button>
          <Button type="button" variant="ghost" className="w-full rounded-full" data-attr="finish-setup-resend" onClick={() => send()}>
            Text a new code
          </Button>
        </>
      )}
      {error ? (
        <p className="text-sm text-danger" role="alert" data-attr="finish-setup-error">
          {error}
        </p>
      ) : null}
    </Shell>
  );
}
