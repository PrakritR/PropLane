"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { PortalSettingsGroup, PortalSettingsRow } from "@/components/portal/portal-settings-ui";
import { ProfilePhoneCodeRow, useProfilePhoneVerify } from "@/components/portal/profile-phone-verify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { startOAuthSignIn } from "@/lib/auth/start-oauth-sign-in";
import Link from "next/link";
import { openServiceWorkspace } from "@/lib/service/open-service-workspace";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { OVERALL_ADMIN_LABEL } from "@/lib/admin-team/admin-team-model";
import { inviteLinkUnusableMessage, type InviteLinkUnusableReason } from "@/lib/invite-links/invite-link-model";

export type AdminInvitePreview = {
  ownerName: string;
  inviteeEmail?: string | null;
  adminRoleLabel?: string | null;
  adminWorkspaceNames?: string[];
  unusableReason?: InviteLinkUnusableReason | null;
};

/**
 * The page an Admin team invite link opens: "Create your admin account" for a new email (name, mobile with a text code,
 * Google or a password), or a plain accept for an account that is already signed in. The grant itself is whatever the
 * inviter stored on the link; nothing here names a role. Redeeming still requires the signed-in email to be the one the
 * link was sent to, which the server enforces.
 */
export function AdminInviteCard({ token, preview, signedIn, onSignedIn }: { token: string; preview: AdminInvitePreview; signedIn: boolean | null; onSignedIn: () => void }) {
  const router = useRouter();
  const invitePath = `/invite/${token}`;
  const boundEmail = preview.inviteeEmail ?? "";
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [landing, setLanding] = useState<(() => void) | null>(null);
  const [createdPhone, setCreatedPhone] = useState("");
  const [verified, setVerified] = useState(false);
  // The emailed-code proof a NEW account needs: the signed challenge the server returned, then the 6 digits.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  // Set when the signed-in account is already on the admin team (the same link opened again).
  const [already, setAlready] = useState<{ overall: boolean } | null>(null);
  const phoneVerify = useProfilePhoneVerify({ phone: createdPhone, onVerified: () => setVerified(true) });

  const roleLabel = preview.adminRoleLabel ?? "Admin";
  const workspaces = preview.adminWorkspaceNames ?? [];
  const isOverall = roleLabel === OVERALL_ADMIN_LABEL;

  /** Redeems the link; the landing to run once the admin is done (after the optional mobile check), or null on failure. */
  const accept = useCallback(async (): Promise<(() => void) | null> => {
    setError(null);
    const res = await fetch("/api/pro/invite-links/redeem", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body = (await res.json().catch(() => ({}))) as { role?: string; workspaceIds?: string[]; error?: string; alreadyRedeemed?: boolean };
    if (!res.ok) {
      setError(body.error ?? "Could not accept this invite.");
      return null;
    }
    if (body.alreadyRedeemed) {
      setAlready({ overall: body.role === "overall_admin" });
      return null;
    }
    const first = body.workspaceIds?.[0];
    return () => {
      if (body.role === "overall_admin") {
        router.replace("/admin/dashboard");
        return;
      }
      if (first) {
        void openServiceWorkspace(first, (href) => window.location.assign(href), { isAdmin: false });
        return;
      }
      router.replace("/portal/dashboard");
    };
  }, [router, token]);

  const run = async (work: () => Promise<(() => void) | null>, holdForPhone = false) => {
    setBusy(true);
    try {
      const go = await work();
      if (!go) return;
      // A number typed on this page gets its text code before the admin lands; everyone else goes straight in.
      if (holdForPhone) setLanding(() => go);
      else go();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  /** Step one for a new account: mail the code to the invited address (the server picks the address, not this page). */
  const sendCode = async (): Promise<null> => {
    setError(null);
    const res = await fetch("/api/pro/invite-links/admin-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send", token }),
    });
    const out = (await res.json().catch(() => ({}))) as { error?: string; challenge?: string };
    if (!res.ok || !out.challenge) {
      setError(out.error ?? "Could not send a code.");
      return null;
    }
    setChallenge(out.challenge);
    return null;
  };

  /** Step two: the code proves the inbox, the server creates the confirmed account, then this signs in and accepts. */
  const createAndAccept = async (): Promise<(() => void) | null> => {
    const res = await fetch("/api/pro/invite-links/admin-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", token, challenge, code, fullName: name, phone, password }),
    });
    const out = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(out.error ?? "Could not create your account.");
      return null;
    }
    const supabase = createSupabaseBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: boundEmail, password });
    if (signInError) {
      setError("Account created. Sign in to finish accepting.");
      return null;
    }
    onSignedIn();
    setCreatedPhone(phone);
    return accept();
  };

  // The same link opened again by an account that already redeemed it: say so instead of "no longer active".
  useEffect(() => {
    if (!signedIn || preview.unusableReason !== "exhausted") return;
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/pro/invite-links/redeem", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const out = (await res.json().catch(() => ({}))) as { role?: string; alreadyRedeemed?: boolean };
      if (cancelled) return;
      if (res.ok && out.alreadyRedeemed) setAlready({ overall: out.role === "overall_admin" });
      else setError(inviteLinkUnusableMessage("exhausted"));
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn, preview.unusableReason, token]);

  const google = async () => {
    setError(null);
    const result = await startOAuthSignIn({ supabase: createSupabaseBrowserClient(), provider: "google", nextPath: invitePath, viaContinue: false });
    if (!result.ok) setError(result.message);
  };

  const header = (
    <div className="flex flex-col items-center text-center" data-attr="admin-invite-header">
      <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground">
        {signedIn ? "Accept your PropLane admin invite" : "Create your admin account"}
      </h1>
      <p className="mt-1 text-[15px] text-foreground/80">{preview.ownerName} invited you</p>
    </div>
  );

  const terms = (
    <div className="mt-6" data-attr="admin-invite-terms">
      <PortalSettingsGroup>
        <PortalSettingsRow label="Role">
          <span className="text-[15px] font-medium text-foreground" data-attr="admin-invite-role">{roleLabel}</span>
        </PortalSettingsRow>
        {!isOverall && workspaces.length > 0 ? (
          <PortalSettingsRow label={workspaces.length === 1 ? "Workspace" : "Workspaces"}>
            <span className="text-[15px] font-medium text-foreground" data-attr="admin-invite-workspaces">{workspaces.join(" · ")}</span>
          </PortalSettingsRow>
        ) : null}
        {boundEmail ? (
          <PortalSettingsRow label="Email">
            <span className="break-all text-[15px] font-medium text-foreground" data-attr="admin-invite-email">{boundEmail}</span>
          </PortalSettingsRow>
        ) : null}
      </PortalSettingsGroup>
    </div>
  );

  if (already) {
    return (
      <AuthCard variant="blend">
        <div className="flex flex-col items-center text-center" data-attr="admin-invite-already">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">You&apos;re already on the PropLane admin team</h1>
        </div>
        <div className="mt-6">
          <Link
            href={already.overall ? "/admin/dashboard" : "/portal/dashboard"}
            className="block w-full rounded-full bg-primary px-4 py-2.5 text-center text-[15px] font-semibold text-primary-foreground"
            data-attr="admin-invite-open"
          >
            {already.overall ? "Open PropLane admin" : "Open your workspace"}
          </Link>
        </div>
      </AuthCard>
    );
  }

  if (preview.unusableReason && !(signedIn && preview.unusableReason === "exhausted" && !error)) {
    return (
      <AuthCard variant="blend">
        <div className="flex flex-col items-center text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">This invite is no longer active</h1>
          <p className="mt-2 text-[15px] text-foreground/80" data-attr="admin-invite-unusable">{inviteLinkUnusableMessage(preview.unusableReason)}</p>
        </div>
      </AuthCard>
    );
  }

  if (preview.unusableReason) {
    return (
      <AuthCard variant="blend">
        <p className="text-center text-sm text-muted">Checking your invite…</p>
      </AuthCard>
    );
  }

  // Accepted: a number typed here gets its text code, then the admin lands.
  if (landing && createdPhone) {
    return (
      <AuthCard variant="blend">
        <div className="flex flex-col items-center text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Verify your mobile</h1>
        </div>
        <div className="mt-6 space-y-4" data-attr="admin-invite-phone">
          {phoneVerify.codeSent && !verified ? (
            <PortalSettingsGroup>
              <ProfilePhoneCodeRow phone={createdPhone} code={phoneVerify.code} onCodeChange={phoneVerify.setCode} error={phoneVerify.error} onConfirm={phoneVerify.confirm} />
            </PortalSettingsGroup>
          ) : null}
          {phoneVerify.error && !phoneVerify.codeSent ? <p className="text-center text-sm text-danger" role="alert">{phoneVerify.error}</p> : null}
          {verified ? (
            <Button type="button" className="w-full rounded-full py-2.5 text-[15px] font-semibold" data-attr="admin-invite-continue" onClick={() => landing()}>
              Continue
            </Button>
          ) : (
            <>
              {!phoneVerify.codeSent ? (
                <Button type="button" className="w-full rounded-full py-2.5 text-[15px] font-semibold" data-attr="admin-invite-send-code" onClick={() => phoneVerify.send()}>
                  Text me a code
                </Button>
              ) : null}
              <Button type="button" variant="outline" className="w-full rounded-full py-2.5 text-[15px] font-semibold" data-attr="admin-invite-skip-phone" onClick={() => landing()}>
                Skip for now
              </Button>
            </>
          )}
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard variant="blend">
      {header}
      {terms}
      {error ? <p className="mt-4 text-center text-sm text-rose-600" role="alert">{error}</p> : null}
      <div className="mt-6">
        {signedIn === false ? (
          <form
            className="grid gap-3"
            data-attr="admin-invite-create"
            onSubmit={(event) => {
              event.preventDefault();
              void run(challenge ? createAndAccept : sendCode, Boolean(phone));
            }}
          >
            <Input aria-label="Full name" placeholder="Full name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input aria-label="Email" type="email" value={boundEmail} readOnly />
            <PhoneNumberField value={phone} onChange={setPhone} dataAttr="admin-invite-phone-field" />
            <Input aria-label="Password" placeholder="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            {challenge ? (
              <Input
                aria-label="6-digit code from your email"
                placeholder="6-digit code from your email"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                data-attr="admin-invite-email-code"
              />
            ) : null}
            <Button
              type="submit"
              className="w-full rounded-full py-2.5 text-[15px] font-semibold"
              data-attr="admin-invite-create-submit"
              loading={busy}
              disabled={!boundEmail || name.trim().length < 2 || password.length < 8 || (challenge !== null && code.length !== 6)}
            >
              {challenge ? "Create admin account" : "Email me a code"}
            </Button>
            <Button type="button" variant="outline" className="w-full rounded-full py-2.5 text-[15px] font-semibold" data-attr="admin-invite-google" onClick={() => void google()}>
              Continue with Google
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full rounded-full py-2.5 text-[15px] font-semibold"
              data-attr="admin-invite-sign-in"
              onClick={() => router.push(`/auth/sign-in?next=${encodeURIComponent(invitePath)}`)}
            >
              I already have an account
            </Button>
          </form>
        ) : (
          <Button
            type="button"
            className="w-full rounded-full py-2.5 text-[15px] font-semibold"
            data-attr="admin-invite-accept"
            loading={busy}
            onClick={() => void run(accept)}
          >
            Accept invite
          </Button>
        )}
      </div>
    </AuthCard>
  );
}
