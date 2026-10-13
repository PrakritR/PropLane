"use client";

import { useEffect, useRef, useState } from "react";
import { ConfirmRows, PortalDialog } from "@/components/portal/portal-dialog";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { SegmentedTwo } from "@/components/ui/segmented-control";
import { Input } from "@/components/ui/input";
import { TEAM_ROLE_LABELS, type TeamRoleId } from "@/lib/co-manager-team-roles";
import {
  inviteLinkUnusableMessage,
  parseInviteInput,
  type InviteLinkUnusableReason,
} from "@/lib/invite-links/invite-link-model";

export type WorkspaceDialogTab = "create" | "join";

type JoinPreview = {
  kind: "manager" | "vendor" | "resident";
  ownerName: string;
  workspaceName: string | null;
  teamRole: TeamRoleId | null;
  houseScope: "all" | "selected";
  houseCount: number;
  canDo: string | null;
  unusableReason: InviteLinkUnusableReason | null;
};

type JoinState =
  | { phase: "idle" }
  | { phase: "loading" }
  /** `message` carries the route's own refusal (429 "Too many tries", 401 sign-in); absent is the flat 404 miss. */
  | { phase: "missing"; message?: string }
  | { phase: "found"; preview: JoinPreview };

const DEBOUNCE_MS = 350;

function houseLabel(preview: JoinPreview): string {
  if (preview.houseScope === "all") return "All houses";
  return preview.houseCount === 1 ? "1 house" : `${preview.houseCount} houses`;
}

/**
 * The rail's (+): one popup, Create | Join. Join takes either the invite link or
 * the workspace code, resolves it (debounced) into a card of facts, and accepts
 * through the same redeem route the invite page uses.
 */
export function WorkspaceCreateJoinDialog({
  open,
  onClose,
  initialTab = "create",
  initialInput = "",
}: {
  open: boolean;
  onClose: () => void;
  initialTab?: WorkspaceDialogTab;
  initialInput?: string;
}) {
  const ctx = useWorkspaces();
  const [tab, setTab] = useState<WorkspaceDialogTab>(initialTab);
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [input, setInput] = useState(initialInput);
  const [join, setJoin] = useState<JoinState>({ phase: "idle" });
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const sequence = useRef(0);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setInput(initialInput);
    setName("");
    setCreateError(null);
    setJoinError(null);
  }, [open, initialTab, initialInput]);

  useEffect(() => {
    sequence.current += 1;
    const mine = sequence.current;
    setJoinError(null);
    if (!open || tab !== "join" || !parseInviteInput(input)) {
      setJoin({ phase: "idle" });
      return;
    }
    setJoin({ phase: "loading" });
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/pro/invite-links/resolve", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input }),
        });
        if (mine !== sequence.current) return;
        if (!res.ok) {
          // 404 is the deliberate flat miss. Anything else (rate limited, signed out) is
          // not "no such workspace" and must not read as one.
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setJoin({ phase: "missing", ...(res.status === 404 ? {} : { message: body.error || "Could not look that up. Try again." }) });
          return;
        }
        setJoin({ phase: "found", preview: (await res.json()) as JoinPreview });
      } catch {
        if (mine === sequence.current) setJoin({ phase: "missing" });
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, tab, input]);

  if (!ctx) return null;

  const create = async () => {
    setCreateError(null);
    try {
      await ctx.mutate({ action: "create", name });
      onClose();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Could not add the workspace.");
    }
  };

  const preview = join.phase === "found" ? join.preview : null;
  const notWorkspaceInvite = preview != null && preview.kind !== "manager";
  const joinBlocked = preview?.unusableReason ?? null;
  const canJoin = preview != null && !notWorkspaceInvite && !joinBlocked && !joining;
  const workspaceLabel = preview?.workspaceName?.trim() || "workspace";

  const accept = async () => {
    setJoining(true);
    setJoinError(null);
    try {
      const res = await fetch("/api/pro/invite-links/redeem", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: input }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; workspaceId?: string | null };
      if (!res.ok) {
        setJoinError(body.error || "Could not join this workspace.");
        return;
      }
      await ctx.refresh();
      if (body.workspaceId) await ctx.select(body.workspaceId);
      onClose();
    } catch {
      setJoinError("Could not join this workspace.");
    } finally {
      setJoining(false);
    }
  };

  const cardRows = (() => {
    if (join.phase === "loading") return [{ label: "Workspace", value: "Looking up…" }];
    if (join.phase === "missing") return [{ label: "Result", value: join.message ?? "No workspace matches that" }];
    if (!preview) return null;
    const rows: Array<{ label: string; value: string }> = [
      { label: "Workspace", value: preview.workspaceName?.trim() || "Workspace" },
      { label: "Owner", value: preview.ownerName },
      { label: "Role", value: preview.teamRole ? TEAM_ROLE_LABELS[preview.teamRole] : "Custom" },
      { label: "Houses", value: houseLabel(preview) },
    ];
    if (notWorkspaceInvite) rows.push({ label: "Result", value: "This is not a workspace invite" });
    else if (joinBlocked) rows.push({ label: "Result", value: inviteLinkUnusableMessage(joinBlocked) });
    if (joinError) rows.push({ label: "Result", value: joinError });
    return rows;
  })();

  return (
    <PortalDialog
      open={open}
      onClose={onClose}
      title="Workspace"
      contextPanel={null}
      preview={null}
      dataAttr="workspace-create-join-dialog"
      primaryAction={
        tab === "create"
          ? { label: "Add workspace", disabled: !name.trim(), dataAttr: "workspace-create-save", onClick: create }
          : { label: `Join ${workspaceLabel}`, disabled: !canJoin, loading: joining, dataAttr: "workspace-join-accept", onClick: accept }
      }
    >
      <div className="space-y-4">
        <SegmentedTwo
          value={tab}
          onChange={setTab}
          left={{ id: "create", label: "Create" }}
          right={{ id: "join", label: "Join" }}
        />
        {tab === "create" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) void create();
            }}
          >
            <label className="block text-xs font-semibold uppercase tracking-wide text-muted" htmlFor="workspace-create-name">
              Workspace name
            </label>
            <Input id="workspace-create-name" className="mt-1.5" autoFocus required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            {createError ? (
              <p role="alert" className="mt-2 text-sm text-danger">
                {createError}
              </p>
            ) : null}
          </form>
        ) : (
          <div>
            <Input
              id="workspace-join-input"
              aria-label="Invite link or workspace code"
              data-attr="workspace-join-input"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the invite link or type the workspace code"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            {cardRows ? (
              <div className="mt-4 rounded-xl border border-border p-4" data-attr="workspace-join-card">
                <ConfirmRows rows={cardRows} />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </PortalDialog>
  );
}
