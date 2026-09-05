"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Link2, Trash2 } from "lucide-react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { CheckboxMultiSelect, type CheckboxMultiSelectOption } from "@/components/ui/checkbox-multi-select";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  DEFAULT_INVITE_LINK_EXPIRY,
  DEFAULT_INVITE_LINK_USES,
  INVITE_LINK_EXPIRY_OPTIONS,
  INVITE_LINK_USE_OPTIONS,
  inviteLinkUnusableReason,
  type InviteLinkKind,
} from "@/lib/invite-links/invite-link-model";
import {
  buildAllModulesGrant,
  describeCoManagerPermissions,
  type CoManagerPermissions,
  type PropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";

type ExistingLink = {
  id: string;
  kind: InviteLinkKind;
  label: string | null;
  assignedPropertyIds: string[];
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

/**
 * Mint a shareable co-manager invite link.
 *
 * The order is the point, and it is the order the permission model needs: the
 * properties and the access are chosen FIRST and stored on the link, so the
 * person who opens it never names their own scope. The expiry and the use
 * budget are what make it safe to paste into a chat.
 */
export function ManagerInviteLinkModal({
  open,
  onClose,
  propertyOptions,
  kind = "manager",
  renderPermissionsEditor,
}: {
  open: boolean;
  onClose: () => void;
  propertyOptions: CheckboxMultiSelectOption[];
  kind?: InviteLinkKind;
  /** Co-manager links only — vendor links do not carry per-module grants. */
  renderPermissionsEditor?: (
    value: CoManagerPermissions,
    onChange: (next: CoManagerPermissions) => void,
  ) => React.ReactNode;
}) {
  const isManagerLink = kind === "manager";
  const { showToast } = useAppUi();
  const [selectedPropIds, setSelectedPropIds] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<PropertyCoManagerPermissions>({});
  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState<string>(DEFAULT_INVITE_LINK_EXPIRY);
  const [uses, setUses] = useState<string>(DEFAULT_INVITE_LINK_USES);
  const [minting, setMinting] = useState(false);
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [links, setLinks] = useState<ExistingLink[]>([]);

  const loadLinks = useCallback(async () => {
    try {
      const res = await fetch("/api/pro/invite-links", { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { links?: ExistingLink[] };
      setLinks((body.links ?? []).filter((link) => link.kind === kind));
    } catch {
      /* the list is a convenience; a failed load must not block minting */
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadLinks();
  }, [loadLinks, open, kind]);

  const setPropertySelection = (next: string[]) => {
    setSelectedPropIds(next);
    setPermissions((prev) => {
      const out: PropertyCoManagerPermissions = {};
      for (const id of next) {
        // A newly ticked property seeds an explicit READ-ONLY grant, never an
        // empty object: empty used to read as full access (PRP-199), so the
        // gesture that adds a property must not be the widest possible grant.
        out[id] = prev[id] ?? buildAllModulesGrant("read");
      }
      return out;
    });
  };

  const mint = async () => {
    setMinting(true);
    try {
      const res = await fetch("/api/pro/invite-links", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          label: label.trim() || undefined,
          assignedPropertyIds: selectedPropIds,
          propertyPermissions: permissions,
          expiry,
          uses,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        showToast(body.error ?? "Could not create the invite link.");
        return;
      }
      // Shown once. The server keeps only a hash, so leaving this screen without
      // copying it means minting a new one.
      setMintedUrl(body.url);
      void loadLinks();
    } catch {
      showToast("Could not create the invite link.");
    } finally {
      setMinting(false);
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      showToast("Invite link copied.");
    } catch {
      showToast("Could not copy. Select the link and copy it manually.");
    }
  };

  const revoke = async (id: string) => {
    const res = await fetch(`/api/pro/invite-links?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok) {
      showToast("Could not turn off that link.");
      return;
    }
    showToast("Invite link turned off.");
    void loadLinks();
  };

  const reset = () => {
    setSelectedPropIds([]);
    setPermissions({});
    setLabel("");
    setExpiry(DEFAULT_INVITE_LINK_EXPIRY);
    setUses(DEFAULT_INVITE_LINK_USES);
    setMintedUrl(null);
  };

  const mintDisabled = isManagerLink ? selectedPropIds.length === 0 : false;

  return (
    <Modal
      open={open}
      title={isManagerLink ? "Create an invite link" : "Create a vendor invite link"}
      description={
        isManagerLink
          ? "Anyone who opens this link joins with exactly the access you set here."
          : "Anyone who opens this link can join your vendor directory on PropLane."
      }
      assistantContext={isManagerLink ? "Co-manager invite link" : "Vendor invite link"}
      assistantStorageScopeKey={isManagerLink ? "Co-manager invite link" : "Vendor invite link"}
      onClose={() => {
        reset();
        onClose();
      }}
      dataAttr="manager-invite-link-modal"
      footer={
        <ModalFooter>
          {mintedUrl ? (
            <Button type="button" onClick={() => reset()} data-attr="invite-link-mint-another">
              Create another
            </Button>
          ) : (
            <Button
              type="button"
              loading={minting}
              disabled={mintDisabled}
              onClick={() => mint()}
              data-attr="invite-link-mint"
            >
              Create link
            </Button>
          )}
        </ModalFooter>
      }
    >
      <div className="space-y-5">
        {mintedUrl ? (
          <div className="rounded-2xl border border-primary/25 bg-primary/[0.05] p-4">
            <p className="text-sm font-semibold text-foreground">Your invite link</p>
            <div className="mt-2 flex items-center gap-2">
              <Input readOnly value={mintedUrl} className="font-mono text-xs" />
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                data-attr="invite-link-copy"
                onClick={() => copy(mintedUrl)}
              >
                <Copy className="h-4 w-4" />
                <span className="ml-1.5">Copy</span>
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted">
              Copy it now — this is the only time it is shown. We store only a fingerprint of it, so
              it cannot be looked up again.
            </p>
          </div>
        ) : (
          <>
            <div>
              <CheckboxMultiSelect
                label={
                  isManagerLink
                    ? "Properties this link grants access to"
                    : "Properties (optional)"
                }
                labelClassName="text-xs font-semibold uppercase tracking-wide text-muted"
                options={propertyOptions}
                selected={selectedPropIds}
                onChange={setPropertySelection}
                emptyLabel="Select properties…"
                searchPlaceholder="Search properties…"
                dataAttr="invite-link-properties"
              />
            </div>

            {isManagerLink && renderPermissionsEditor
              ? selectedPropIds.map((pid) => (
                  <div key={pid} className="rounded-xl border border-border bg-accent/25 p-4">
                    <p className="text-sm font-semibold text-foreground">
                      {propertyOptions.find((o) => o.value === pid)?.label ?? "Property"}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {describeCoManagerPermissions(permissions[pid] ?? {})}
                    </p>
                    <div className="mt-3">
                      {renderPermissionsEditor(permissions[pid] ?? {}, (next) =>
                        setPermissions((prev) => ({ ...prev, [pid]: next })),
                      )}
                    </div>
                  </div>
                ))
              : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
                Expires after
                <Select
                  className="mt-1.5"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                  data-attr="invite-link-expiry"
                >
                  {INVITE_LINK_EXPIRY_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
                Max number of uses
                <Select
                  className="mt-1.5"
                  value={uses}
                  onChange={(e) => setUses(e.target.value)}
                  data-attr="invite-link-uses"
                >
                  {INVITE_LINK_USE_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </label>
            </div>

            <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
              Label (optional)
              <Input
                className="mt-1.5"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Seattle team"
              />
            </label>
          </>
        )}

        {links.length > 0 ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Active links</p>
            <ul className="mt-2 space-y-2">
              {links.map((link) => {
                const unusable = inviteLinkUnusableReason({
                  expiresAt: link.expiresAt,
                  revokedAt: link.revokedAt,
                  maxUses: link.maxUses,
                  usedCount: link.usedCount,
                });
                return (
                  <li
                    key={link.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                        <Link2 className="h-3.5 w-3.5 shrink-0 text-muted" />
                        {link.label?.trim() || `${link.assignedPropertyIds.length} propert${link.assignedPropertyIds.length === 1 ? "y" : "ies"}`}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        {/* Never the link itself — only the hash is kept. */}
                        {link.usedCount} of {link.maxUses ?? "∞"} uses
                        {link.expiresAt ? ` · expires ${new Date(link.expiresAt).toLocaleDateString()}` : " · never expires"}
                        {unusable ? " · no longer active" : ""}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0 border-rose-200 text-rose-800 portal-danger-outline"
                      data-attr="invite-link-revoke"
                      onClick={() => void revoke(link.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                      <span className="ml-1.5">Turn off</span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
