"use client";

import { useState, type ReactNode } from "react";
import { ExternalLink, Pencil } from "lucide-react";

import { CopyIconAction, PortalIconAction } from "@/components/portal/portal-icon-action";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter, useModalPresentation } from "@/components/ui/modal";
import { saveVendorMarketplaceAccount } from "@/hooks/use-vendor-marketplace-accounts";
import { track } from "@/lib/analytics/track-client";
import { shortDate } from "@/lib/listing-channels/row-fact";
import { copyTextToClipboard } from "@/lib/manager-property-links";
import {
  buildVendorJobPostText,
  marketplacePostUrl,
  marketplaceSearchUrl,
  type MarketplaceLocation,
  type ServiceKind,
  type VendorMarketplaceAccountRow,
  type VendorMarketplaceDef,
} from "@/lib/vendor-marketplaces/registry";

const ICON_LINK = "grid size-9 place-items-center rounded-full text-foreground/80 hover:bg-foreground/5";

function Step({ n, done, title, children, action, dataAttr }: { n: number; done?: boolean; title: string; children?: ReactNode; action?: ReactNode; dataAttr: string }) {
  return (
    <div className="flex items-start gap-3 border-b border-border py-3 last:border-0" data-attr={dataAttr}>
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent/60 text-xs text-foreground" aria-hidden>
        {done ? "✓" : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] text-foreground">{title}</p>
        {children}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

/** Add (or change) the account the manager holds at one marketplace: a label and an optional https profile link. Never a password. */
export function VendorMarketplaceAccountModal({
  def,
  service,
  account,
  workspaceId,
  open,
  onClose,
  onSaved,
}: {
  def: VendorMarketplaceDef;
  service: ServiceKind;
  account: VendorMarketplaceAccountRow | null;
  workspaceId?: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const presentation = useModalPresentation();
  const { showToast } = useAppUi();
  const [label, setLabel] = useState(account?.accountLabel ?? "");
  const [profileUrl, setProfileUrl] = useState(account?.profileUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const Glyph = def.glyph.icon;

  const save = async () => {
    setError(null);
    const res = await saveVendorMarketplaceAccount({
      marketplace: def.id,
      accountLabel: label.trim(),
      ...(profileUrl.trim() ? { profileUrl: profileUrl.trim() } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    });
    if (!res.ok) {
      setError(res.error ?? "Could not save.");
      return;
    }
    track("vendor_marketplace_action", { marketplace: def.id, action: "save_account", service });
    showToast(`${def.label} account added.`);
    await onSaved();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      presentation={presentation}
      preview={null}
      contextPanel={null}
      assistantStrip={false}
      dataAttr={`vendor-marketplace-account-${def.id}`}
      title={
        <span className="flex items-center gap-2">
          <Glyph className={`size-5 ${def.glyph.tone}`} aria-hidden />
          {account ? "Edit account" : "Add account"}
        </span>
      }
      footer={
        <ModalFooter>
          <Button data-attr={`vendor-marketplace-account-save-${def.id}`} disabled={!label.trim()} onClick={() => save()}>
            Save
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-3 pb-2">
        <label className="block text-xs uppercase text-muted" htmlFor={`vendor-marketplace-label-${def.id}`}>
          Email or name used on {def.label}
        </label>
        <Input
          id={`vendor-marketplace-label-${def.id}`}
          value={label}
          maxLength={120}
          autoComplete="off"
          onChange={(e) => setLabel(e.target.value)}
          data-attr={`vendor-marketplace-account-label-${def.id}`}
        />
        <label className="block text-xs uppercase text-muted" htmlFor={`vendor-marketplace-url-${def.id}`}>
          Profile link (optional)
        </label>
        <Input
          id={`vendor-marketplace-url-${def.id}`}
          type="url"
          value={profileUrl}
          placeholder="https://"
          autoComplete="off"
          onChange={(e) => setProfileUrl(e.target.value)}
          data-attr={`vendor-marketplace-account-url-${def.id}`}
        />
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** The how-to for hiring through one marketplace: account, post text, the post page, a search near the house. */
export function VendorMarketplaceGuide({
  def,
  service,
  location,
  account,
  canManage,
  workspaceId,
  open,
  onClose,
  onAccountChanged,
}: {
  def: VendorMarketplaceDef;
  service: ServiceKind;
  location: MarketplaceLocation;
  account: VendorMarketplaceAccountRow | null;
  /** Only the workspace owner may add or change the account row (the route refuses the rest). */
  canManage: boolean;
  workspaceId?: string;
  open: boolean;
  onClose: () => void;
  onAccountChanged: () => void | Promise<void>;
}) {
  const presentation = useModalPresentation();
  const { showToast } = useAppUi();
  const [accountOpen, setAccountOpen] = useState(false);
  const Glyph = def.glyph.icon;
  const postText = buildVendorJobPostText({ service, city: location.city, zip: location.zip });
  const postUrl = marketplacePostUrl(def, service, location);
  const searchUrl = marketplaceSearchUrl(def, service, location);
  const base = { marketplace: def.id, service };

  const copyPost = async () => {
    const ok = await copyTextToClipboard(postText);
    if (ok) track("vendor_marketplace_action", { ...base, action: "copy_post" });
    showToast(ok ? `Post copied. Paste it into ${def.label}.` : "Could not copy the post.");
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        presentation={presentation}
        preview={null}
        contextPanel={null}
        assistantStrip={false}
        dismissBlocked={accountOpen}
        dataAttr={`vendor-marketplace-guide-${def.id}`}
        title={
          <span className="flex items-center gap-2">
            <Glyph className={`size-5 ${def.glyph.tone}`} aria-hidden />
            {def.label}
          </span>
        }
      >
        <div className="space-y-3 pb-2" data-attr="vendor-marketplace-guide">
          <p className="text-sm text-foreground" data-attr="vendor-marketplace-guide-how">
            {def.guide.how}
          </p>
          <p className="text-sm text-foreground" data-attr="vendor-marketplace-guide-cost">
            {def.guide.cost}
          </p>
          <div className="flex items-center justify-between text-sm" data-attr="vendor-marketplace-guide-direct">
            <span className="text-foreground">Direct connection</span>
            <span className="text-muted" aria-disabled="true">
              Coming soon
            </span>
          </div>

          <div data-attr="vendor-marketplace-guide-steps">
            <Step
              n={1}
              done={Boolean(account)}
              title={account ? `Account added · ${account.accountLabel}${shortDate(account.connectedAt) ? ` · ${shortDate(account.connectedAt)}` : ""}` : "Account"}
              dataAttr="vendor-marketplace-guide-step-1"
              action={
                <>
                  {account ? null : (
                    <a
                      href={def.signupUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={ICON_LINK}
                      data-attr={`vendor-marketplace-signup-${def.id}`}
                      aria-label={`Open ${def.label} sign-up`}
                      title={`Open ${def.label} sign-up`}
                    >
                      <ExternalLink className="size-4" aria-hidden />
                    </a>
                  )}
                  {!canManage ? null : account ? (
                    <PortalIconAction
                      icon={Pencil}
                      label="Edit account"
                      data-attr={`vendor-marketplace-edit-account-${def.id}`}
                      onClick={() => setAccountOpen(true)}
                    />
                  ) : (
                    <Button
                      variant="ghost"
                      data-attr={`vendor-marketplace-add-account-${def.id}`}
                      onClick={() => {
                        track("vendor_marketplace_action", { ...base, action: "add_account" });
                        setAccountOpen(true);
                      }}
                    >
                      Add account
                    </Button>
                  )}
                </>
              }
            />
            <Step
              n={2}
              title="Copy job post"
              dataAttr="vendor-marketplace-guide-step-2"
              action={<CopyIconAction label="Copy post" data-attr={`vendor-marketplace-copy-${def.id}`} onCopy={copyPost} />}
            >
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-accent/40 p-3 text-xs text-foreground" data-attr="vendor-marketplace-guide-post">
                {postText}
              </pre>
            </Step>
            <Step
              n={3}
              title="Post a job"
              dataAttr="vendor-marketplace-guide-step-3"
              action={
                <a
                  href={postUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={ICON_LINK}
                  data-attr={`vendor-marketplace-post-${def.id}`}
                  aria-label={`Open ${def.label} to post a job`}
                  title={`Open ${def.label} to post a job`}
                  onClick={() => track("vendor_marketplace_action", { ...base, action: "post_job" })}
                >
                  <ExternalLink className="size-4" aria-hidden />
                </a>
              }
            />
            <Step
              n={4}
              title="Search pros near the house"
              dataAttr="vendor-marketplace-guide-step-4"
              action={
                <a
                  href={searchUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={ICON_LINK}
                  data-attr={`vendor-marketplace-guide-search-${def.id}`}
                  aria-label={`Search ${def.label}`}
                  title={`Search ${def.label}`}
                  onClick={() => track("vendor_marketplace_action", { ...base, action: "search" })}
                >
                  <ExternalLink className="size-4" aria-hidden />
                </a>
              }
            />
          </div>

          {def.guide.rules.length > 0 ? (
            <div data-attr="vendor-marketplace-guide-rules">
              <h3 className="text-sm font-medium text-foreground">Keep the account safe</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">
                {def.guide.rules.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Modal>
      {accountOpen ? (
        <VendorMarketplaceAccountModal
          def={def}
          service={service}
          account={account}
          workspaceId={workspaceId}
          open
          onClose={() => setAccountOpen(false)}
          onSaved={onAccountChanged}
        />
      ) : null}
    </>
  );
}
