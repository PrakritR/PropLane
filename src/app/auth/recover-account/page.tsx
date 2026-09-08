"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { clearPortalBrowserCache } from "@/lib/auth/clear-portal-browser-cache";

type SavedRequest = { id: string; portal: string; state: string; expiresAt: string; expired: boolean };

export default function RecoverAccountPage() {
  const proofRead = useRef(false);
  const [request, setRequest] = useState<SavedRequest | null>(null);
  const [proof, setProof] = useState({ request: "", token: "" });
  const [loading, setLoading] = useState(true);
  const [signedOut, setSignedOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmFresh, setConfirmFresh] = useState(false);
  const [destination, setDestination] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const portal = new URLSearchParams(window.location.search).get("portal");
      const response = await fetch(`/api/auth/account-recovery${portal ? `?portal=${encodeURIComponent(portal)}` : ""}`, { cache: "no-store" });
      setSignedOut(response.status === 401);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "We couldn't check your saved data.");
      setRequest(data.request);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Please try again."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (!mounted) return;
      if (!proofRead.current) {
        proofRead.current = true;
        const fragment = new URLSearchParams(window.location.hash.slice(1));
        setProof({ request: fragment.get("request") ?? "", token: fragment.get("token") ?? "" });
        // Keep the one-time proof in memory, never in analytics or browser storage.
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      void load();
    });
    return () => { mounted = false; };
  }, [load]);

  async function submit(action: "verify" | "recover" | "fresh") {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/auth/account-recovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        action, portal: request?.portal, requestId: proof.request, token: proof.token,
        ...(action === "fresh" && confirmFresh ? { confirm: "DELETE" } : {}),
      }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "We couldn't complete your choice.");
      if (action === "verify") setNotice("Check your email for a verification link. Opening the link does not choose an option for you.");
      else {
        if (data.signedOut) await createSupabaseBrowserClient().auth.signOut().catch(() => undefined);
        setProof({ request: "", token: "" });
        setNotice(action === "fresh" ? "Your retained personal data has been deleted. You can set up a new account." :
          `Your data has been recovered.${data.waiting ? " Some shared records are waiting for the other account holder's choice." : ""}${data.unavailable ? " Some shared records were permanently deleted by their other owner and could not be recovered." : ""}`);
        setDestination(data.redirectTo);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Please try again."); }
    finally { setBusy(false); }
  }

  const ready = request?.state === "retained" && !request.expired;
  const verifiedLink = ready && proof.request === request.id && /^[A-Za-z0-9_-]{43}$/.test(proof.token);
  return <AuthCard>
    <div className="space-y-5" aria-busy={loading || busy}>
      <h1 className="text-2xl font-semibold">Your saved account data</h1>
      {loading ? <p role="status">Checking for saved data…</p> : <>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        {destination ? <Button className="w-full" data-attr="account-recovery-continue" onClick={() => { clearPortalBrowserCache(); window.location.replace(destination); }}>Continue</Button> : signedOut ?
          <><p className="text-sm text-muted-foreground">Sign in with the account you deleted, then reopen the verification link from your email.</p><Button asChild className="w-full"><Link href="/auth/sign-in">Sign in</Link></Button></> : request ? <>
            <p className="text-sm text-muted-foreground">Your deleted {request.portal} data is held privately until {new Date(request.expiresAt).toLocaleString()}. Choose whether to recover it or start fresh. Taking no action keeps the original deadline.</p>
            <p className="text-sm text-muted-foreground">Financial history owned by another account remains with that owner. Recovering does not restart subscriptions or restore old access keys, invitations, or queued actions.</p>
            {!ready ? <><p role="status">{request.expired ? "The recovery window has ended. Permanent cleanup is pending or in progress." : "Your account cleanup is processing. Check again shortly."}</p><Button variant="outline" data-attr="account-recovery-refresh" onClick={() => void load()}>Check again</Button></> : <>
              {!verifiedLink ? <Button className="w-full" disabled={busy} data-attr="account-recovery-verify" onClick={() => void submit("verify")}>{busy ? "Sending…" : "Send email verification"}</Button> : <>
                <Button className="w-full" disabled={busy} data-attr="account-recovery-recover" onClick={() => void submit("recover")}>Recover my data</Button>
                <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-4" checked={confirmFresh} disabled={busy} onChange={event => setConfirmFresh(event.target.checked)} data-attr="account-recovery-fresh-confirm" /><span>I want to permanently delete my retained data and start fresh. This cannot be undone.</span></label>
                <Button variant="danger" className="w-full" disabled={busy || !confirmFresh} data-attr="account-recovery-fresh" onClick={() => void submit("fresh")}>Delete saved data and start fresh</Button>
                <Button variant="outline" className="w-full" disabled={busy} data-attr="account-recovery-new-link" onClick={() => void submit("verify")}>Send a new verification link</Button>
              </>}
            </>}
          </> : <><p className="text-sm text-muted-foreground">{error ? "Your saved data has not been changed." : "There is no pending recovery for this account."}</p>{error ? <Button variant="outline" onClick={() => void load()} data-attr="account-recovery-retry">Try again</Button> : <Button asChild><Link href="/auth/get-started">Continue setup</Link></Button>}</>}
      </>}
    </div>
  </AuthCard>;
}
