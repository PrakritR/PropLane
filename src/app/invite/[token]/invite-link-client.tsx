"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { PortalSettingsGroup, PortalSettingsRow } from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { inviteLinkUnusableMessage, type InviteLinkUnusableReason, MANAGER_ROLE_REQUIRED_CODE } from "@/lib/invite-links/invite-link-model";
import { firstNameFromDisplay, inviteAcceptTitle } from "@/lib/invite-links/invite-accept-copy";
import { teamRoleListLabel } from "@/lib/co-manager-team-roles";

type Preview = {
  kind: "manager" | "vendor" | "resident";
  ownerName: string;
  workspaceName?: string | null;
  ownerUserId?: string;
  propertyLabels: string[];
  teamRole?: string | null;
  houseScope?: "all" | "selected";
  houseCount?: number;
  canDo?: string | null;
  access?: string | null;
  /** A PropLane Service invite is sent to one address: the sign-up below is locked to it. */
  inviteeEmail?: string | null;
  unusableReason: InviteLinkUnusableReason | null;
};


function initialsOf(label: string): string {
  const parts = label.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** Initials tile, heading and an optional one-line "who invited you". */
function InviteHeader({ tile, title, line }: { tile: string; title: string; line?: string }) {
  return (
    <div className="flex flex-col items-center text-center" data-attr="invite-link-header">
      <div
        className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-primary/10 text-lg font-semibold text-primary"
        aria-hidden
        data-attr="invite-link-tile"
      >
        {initialsOf(tile)}
      </div>
      <h1 className="mt-4 break-words text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      {line ? <p className="mt-1 text-[15px] text-foreground/80">{line}</p> : null}
    </div>
  );
}

function InviteValue({ attr, children }: { attr: string; children: React.ReactNode }) {
  return (
    <span className="block break-words text-[15px] font-medium text-foreground" data-attr={attr}>
      {children}
    </span>
  );
}

/**
 * The screen an invite link opens.
 *
 * Redeeming is a click, never automatic on load: it links the opener's account
 * to someone else's portfolio, and a page that did it on arrival would mean a
 * URL in a group chat could quietly change your account. Signing in first is
 * required for the same reason — there has to be an account for the grant to
 * land on, and it has to be the one the person meant.
 *
 * Manager share links Join in one step (accepted membership + workspace select).
 * Without a manager portal role the opener is sent to create a manager account
 * and brought back here.
 */
export default function InviteLinkClient({ token }: { token: string }) {
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [needManagerAccount, setNeedManagerAccount] = useState(false);
  // Property owner invite: sign up inline (an owner needs no manager account).
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");

  const invitePath = `/invite/${token}`;
  const createManagerHref = `/auth/create-account?mode=create&role=manager&tier=free&next=${encodeURIComponent(invitePath)}`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const supabase = createSupabaseBrowserClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!cancelled) setSignedIn(Boolean(session));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/pro/invite-links/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        const loaded = (await res.json()) as Preview;
        setPreview(loaded);
        if (loaded.inviteeEmail) setOwnerEmail(loaded.inviteeEmail);
      } catch {
        if (!cancelled) setNotFound(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const selectJoinedWorkspace = useCallback(async (workspaceId: string | null | undefined) => {
    const id = workspaceId?.trim();
    if (!id) return;
    try {
      await fetch("/api/workspaces", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "select", id }),
      });
    } catch {
      /* Selection is best-effort — membership already landed. */
    }
  }, []);

  const isOwnerInvite = preview?.teamRole === "property_owner";

  const accept = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNeedManagerAccount(false);
    try {
      const res = await fetch("/api/pro/invite-links/redeem", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        kind?: string;
        inviteId?: string;
        claimId?: string;
        vendorDirectoryId?: string;
        workspaceId?: string | null;
        error?: string;
        code?: string;
      };
      if (!res.ok) {
        if (body.code === MANAGER_ROLE_REQUIRED_CODE || /manager account/i.test(body.error ?? "")) {
          setNeedManagerAccount(true);
          setError(body.error ?? "Create a manager account to join this workspace.");
          return;
        }
        setError(body.error ?? "Could not accept this invite.");
        return;
      }
      // A RESIDENT link grants nothing on redeem — it files a request the
      // manager approves — so there is no accept screen to hand off to. Saying
      // so plainly is the honest end of this flow; anything that looked like
      // "you're in" would be a lie until a manager acts.
      if (body.kind === "resident") {
        if (!body.claimId) {
          setError(body.error ?? "Could not send your request.");
          return;
        }
        setClaimed(true);
        return;
      }
      if (body.kind === "vendor") {
        if (!body.vendorDirectoryId) {
          setError(body.error ?? "Could not join as a vendor.");
          return;
        }
        router.replace("/vendor");
        return;
      }
      if (!body.inviteId) {
        setError(body.error ?? "Could not accept this invite.");
        return;
      }
      if (isOwnerInvite) {
        // An owner has no workspace to switch into: they land in the Property portal.
        router.replace("/portal/dashboard");
        return;
      }
      await selectJoinedWorkspace(body.workspaceId);
      router.replace("/portal/dashboard");
    } catch {
      setError("Could not accept this invite.");
    } finally {
      setBusy(false);
    }
  }, [router, selectJoinedWorkspace, token, isOwnerInvite]);

  const createOwnerAccountAndJoin = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ownerEmail, password: ownerPassword, fullName: ownerName }),
      });
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(out.error ?? "Could not create your account.");
        return;
      }
      const supabase = createSupabaseBrowserClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: ownerEmail.trim().toLowerCase(),
        password: ownerPassword,
      });
      if (signInError) {
        setError("Account created. Sign in to finish joining.");
        return;
      }
      setSignedIn(true);
    } catch {
      setError("Could not create your account.");
      return;
    } finally {
      setBusy(false);
    }
    await accept();
  };

  if (notFound) {
    return (
      <AuthCard variant="blend">
        <InviteHeader tile="PL" title="Invite not found" />
        <PortalSettingsGroup className="mt-6">
          <PortalSettingsRow label="Status">
            <InviteValue attr="invite-link-status">This link is not valid. Ask for a new one.</InviteValue>
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </AuthCard>
    );
  }

  if (!preview) {
    return (
      <AuthCard variant="blend">
        <p className="text-center text-sm text-muted">Loading…</p>
      </AuthCard>
    );
  }

  const isVendor = preview.kind === "vendor";
  const isResident = preview.kind === "resident";
  const isManager = preview.kind === "manager";
  const workspaceLabel = preview.workspaceName?.trim() || "workspace";
  const ownerFirst = firstNameFromDisplay(preview.ownerName);
  const invitedLine = `${preview.ownerName} invited you`;
  const messageHref = preview.ownerUserId
    ? `/portal/communication?composeToUserId=${encodeURIComponent(preview.ownerUserId)}`
    : `/auth/sign-in?next=${encodeURIComponent(invitePath)}`;

  if (preview.unusableReason) {
    return (
      <AuthCard variant="blend">
        <InviteHeader tile={isManager ? workspaceLabel : preview.ownerName} title="This invite is no longer active" />
        <PortalSettingsGroup className="mt-6">
          <PortalSettingsRow label="Status">
            <InviteValue attr="invite-link-status">{inviteLinkUnusableMessage(preview.unusableReason)}</InviteValue>
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </AuthCard>
    );
  }

  // A resident's claim is filed, not granted. Ending on "we sent your request"
  // is the truthful screen: nothing about their account has changed yet.
  if (claimed) {
    return (
      <AuthCard variant="blend">
        <InviteHeader tile={preview.ownerName} title="Request sent" />
        <PortalSettingsGroup className="mt-6">
          <PortalSettingsRow label="Next">
            <InviteValue attr="invite-link-status">{preview.ownerName} confirms you live here</InviteValue>
          </PortalSettingsRow>
          <PortalSettingsRow label="Then">
            <InviteValue attr="invite-link-status-then">You get an email</InviteValue>
          </PortalSettingsRow>
        </PortalSettingsGroup>
        <div className="mt-6">
          <Button
            type="button"
            className="w-full rounded-full py-2.5 text-[15px] font-semibold"
            onClick={() => router.push("/")}
          >
            Done
          </Button>
        </div>
      </AuthCard>
    );
  }

  if (needManagerAccount && isManager) {
    return (
      <AuthCard variant="blend">
        <InviteHeader tile={workspaceLabel} title="Create a manager account" />
        <PortalSettingsGroup className="mt-6">
          <PortalSettingsRow label="Workspace">
            <InviteValue attr="invite-link-status">{workspaceLabel}</InviteValue>
          </PortalSettingsRow>
          <PortalSettingsRow label="Then">
            <InviteValue attr="invite-link-status-then">Back to this invite</InviteValue>
          </PortalSettingsRow>
        </PortalSettingsGroup>
        {error ? <p className="mt-4 text-center text-sm text-rose-600">{error}</p> : null}
        <div className="mt-6 grid gap-3">
          <Button
            type="button"
            className="w-full rounded-full py-2.5 text-[15px] font-semibold"
            data-attr="invite-link-create-manager"
            onClick={() => router.push(createManagerHref)}
          >
            Create manager account
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full rounded-full py-2.5 text-[15px] font-semibold"
            onClick={() => router.push(`/auth/sign-in?next=${encodeURIComponent(invitePath)}`)}
          >
            Sign in with another account
          </Button>
        </div>
      </AuthCard>
    );
  }

  const housesValue =
    preview.houseScope === "all"
      ? `All ${preview.houseCount ?? preview.propertyLabels.length}, and any added later`
      : preview.propertyLabels.length > 0
        ? preview.propertyLabels.join(" · ")
        : "Assigned after you join";
  const propertiesLabel = isResident
    ? preview.propertyLabels.length === 1
      ? "Home"
      : "Homes"
    : preview.propertyLabels.length === 1
      ? "Property"
      : "Properties";
  const isOwner = preview.teamRole === "property_owner";

  return (
    <AuthCard variant="blend">
      {isManager ? (
        <InviteHeader tile={workspaceLabel} title={`Join ${workspaceLabel}`} line={invitedLine} />
      ) : (
        <InviteHeader tile={preview.ownerName} title={inviteAcceptTitle(preview.kind)} line={invitedLine} />
      )}

      <div className="mt-6" data-attr="invite-link-terms"><PortalSettingsGroup>
        {isManager ? (
          <>
            {preview.teamRole ? (
              <PortalSettingsRow label="Role">
                <InviteValue attr="invite-link-role">{teamRoleListLabel(preview.teamRole)}</InviteValue>
              </PortalSettingsRow>
            ) : null}
            <PortalSettingsRow label="Houses">
              <InviteValue attr="invite-link-houses">{housesValue}</InviteValue>
            </PortalSettingsRow>
            {preview.access || preview.canDo ? (
              <PortalSettingsRow label="Access">
                <InviteValue attr="invite-link-can-do">{preview.access ?? preview.canDo}</InviteValue>
              </PortalSettingsRow>
            ) : null}
            {isOwner ? null : (
              <PortalSettingsRow label="Credits">
                <InviteValue attr="invite-link-credits">Follow the owner’s plan</InviteValue>
              </PortalSettingsRow>
            )}
          </>
        ) : (
          <>
            {preview.propertyLabels.length > 0 ? (
              <PortalSettingsRow label={propertiesLabel}>
                <InviteValue attr="invite-link-houses">{preview.propertyLabels.join(" · ")}</InviteValue>
              </PortalSettingsRow>
            ) : null}
            <PortalSettingsRow label={isResident ? "Next" : "Access"}>
              <InviteValue attr="invite-link-can-do">
                {isResident ? `${ownerFirst} confirms it` : "Their vendor directory"}
              </InviteValue>
            </PortalSettingsRow>
          </>
        )}
      </PortalSettingsGroup></div>

      {error ? <p className="mt-4 text-center text-sm text-rose-600">{error}</p> : null}

      <div className="mt-6">
        {signedIn === false && isOwner ? (
          <form
            className="grid gap-3"
            data-attr="invite-link-owner-signup"
            onSubmit={(e) => {
              e.preventDefault();
              void createOwnerAccountAndJoin();
            }}
          >
            <Input aria-label="Your name" placeholder="Your name" autoComplete="name" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
            <Input aria-label="Email" placeholder="Email" type="email" autoComplete="email" value={ownerEmail} readOnly={Boolean(preview.inviteeEmail)} onChange={(e) => setOwnerEmail(e.target.value)} />
            <Input
              aria-label="Password"
              placeholder="Password"
              type="password"
              autoComplete="new-password"
              value={ownerPassword}
              onChange={(e) => setOwnerPassword(e.target.value)}
            />
            <Button
              type="submit"
              className="w-full rounded-full py-2.5 text-[15px] font-semibold"
              data-attr="invite-link-owner-create"
              loading={busy}
              disabled={!ownerEmail.includes("@") || ownerPassword.length < 8}
            >
              Create account and join
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full rounded-full py-2.5 text-[15px] font-semibold"
              onClick={() => router.push(`/auth/sign-in?next=${encodeURIComponent(invitePath)}`)}
            >
              Sign in instead
            </Button>
          </form>
        ) : signedIn === false ? (
          <Button
            type="button"
            className="w-full rounded-full py-2.5 text-[15px] font-semibold"
            onClick={() =>
              router.push(`/auth/sign-in?next=${encodeURIComponent(invitePath)}`)
            }
          >
            {isResident
              ? "Sign in or create an account"
              : isVendor
                ? "Sign in or create an account"
                : "Sign in to join"}
          </Button>
        ) : (
          <Button
            type="button"
            className="w-full rounded-full py-2.5 text-[15px] font-semibold"
            data-attr="invite-link-accept"
            loading={busy}
            onClick={() => accept()}
          >
            {isResident
              ? "This is my home"
              : isVendor
                ? "Join as vendor"
                : `Join ${workspaceLabel}`}
          </Button>
        )}
        {!isResident && !isOwner ? (
          <Button
            type="button"
            variant="outline"
            className="mt-3 w-full rounded-full py-2.5 text-[15px] font-semibold"
            data-attr="invite-link-message-inviter"
            onClick={() => router.push(messageHref)}
          >
            Message {firstNameFromDisplay(preview.ownerName)}
          </Button>
        ) : null}
      </div>
    </AuthCard>
  );
}
