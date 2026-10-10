"use client";

import { useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Search } from "lucide-react";

import { IntegrationRow } from "@/components/portal/integration-row";
import { VendorMarketplaceAccountModal, VendorMarketplaceGuide } from "@/components/portal/vendor-marketplace-guide";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";
import { removeVendorMarketplaceAccount, useVendorMarketplaceAccounts } from "@/hooks/use-vendor-marketplace-accounts";
import { track } from "@/lib/analytics/track-client";
import { shortDate } from "@/lib/listing-channels/row-fact";
import { getPropertyById } from "@/lib/rental-application/data";
import {
  DEFAULT_SERVICE,
  SERVICE_KINDS,
  SERVICE_LABELS,
  isServiceKind,
  marketplaceSearchUrl,
  marketplacesForService,
  type MarketplaceLocation,
  type ServiceKind,
  type VendorMarketplaceDef,
  type VendorMarketplaceId,
} from "@/lib/vendor-marketplaces/registry";

const SERVICE_OPTIONS = SERVICE_KINDS.map((kind) => ({ value: kind, label: SERVICE_LABELS[kind] }));

/** The ZIP and city a house gives a search link. Empty when the house is unknown. */
function houseLocation(propertyId: string): MarketplaceLocation {
  if (!propertyId) return {};
  const property = getPropertyById(propertyId);
  const submission = property?.listingSubmission;
  return {
    zip: (submission?.zip || property?.zip || "").trim(),
    city: (submission?.city || property?.neighborhood || "").trim(),
  };
}

/** Stops a click or key inside the row's actions from also opening the row's guide. */
const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();

/** Vendors › Vendor services: outside marketplaces for odd jobs, filtered to the chosen service. */
export function VendorServicesPanel() {
  const workspaceCtx = useWorkspaces();
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const { accountFor, workspaceId, refresh } = useVendorMarketplaceAccounts();
  const propertyIds = useMemo(() => workspaceCtx?.active?.propertyIds ?? [], [workspaceCtx?.active?.propertyIds]);
  const labels = workspaceCtx?.active?.propertyLabels;
  const [service, setService] = useState<ServiceKind>(DEFAULT_SERVICE);
  const [pickedHouse, setPickedHouse] = useState<string | null>(null);
  const [guideId, setGuideId] = useState<VendorMarketplaceId | null>(null);
  const [accountModalId, setAccountModalId] = useState<VendorMarketplaceId | null>(null);

  const houseId = pickedHouse && propertyIds.includes(pickedHouse) ? pickedHouse : (propertyIds[0] ?? "");
  const houseOptions = propertyIds.map((id) => ({ value: id, label: labels?.[id]?.trim() || id }));
  const location = useMemo(() => houseLocation(houseId), [houseId]);
  const rows = marketplacesForService(service);
  const guideDef = guideId ? rows.find((d) => d.id === guideId) ?? null : null;
  const accountDef = accountModalId ? rows.find((d) => d.id === accountModalId) ?? null : null;

  // Phones keep the site's name whole: the fact shortens to "Added" and "No account yet" drops out.
  const factFor = (def: VendorMarketplaceDef) => {
    const account = accountFor(def.id);
    if (!account) return <span className="max-sm:hidden">No account yet</span>;
    const date = shortDate(account.connectedAt);
    return (
      <>
        <span className="max-sm:hidden">{date ? `Account added · ${date}` : "Account added"}</span>
        <span className="sm:hidden">Added</span>
      </>
    );
  };

  const openGuide = (def: VendorMarketplaceDef) => {
    track("vendor_marketplace_action", { marketplace: def.id, action: "open_guide", service });
    setGuideId(def.id);
  };

  const removeAccount = async (def: VendorMarketplaceDef) => {
    const ok = await confirm({
      title: "Remove account",
      description: `Remove your ${def.label} account from PropLane? Your ${def.label} account itself is not changed.`,
      confirmLabel: "Remove",
      note: null,
      tone: "danger",
      dataAttr: `vendor-marketplace-remove-confirm-${def.id}`,
    });
    if (!ok) return;
    const res = await removeVendorMarketplaceAccount({ marketplace: def.id, ...(workspaceId ? { workspaceId } : {}) });
    if (!res.ok) {
      showToast(res.error ?? "Could not remove the account.");
      return;
    }
    track("vendor_marketplace_action", { marketplace: def.id, action: "remove_account", service });
    await refresh();
  };

  return (
    <div data-attr="vendor-services-panel">
      <div className="grid gap-3 border-b border-border px-4 py-3 sm:grid-cols-2" data-attr="vendor-services-controls">
        <FieldSingleSelect
          label="Service"
          options={SERVICE_OPTIONS}
          value={service}
          onChange={(next) => {
            if (isServiceKind(next)) setService(next);
          }}
          dataAttr="vendor-services-service-picker"
        />
        {houseOptions.length > 0 ? (
          <FieldSingleSelect label="House" options={houseOptions} value={houseId} onChange={setPickedHouse} dataAttr="vendor-services-house-picker" />
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-foreground" data-attr="vendor-services-empty">
          No marketplaces offer {SERVICE_LABELS[service].toLowerCase()}.
        </p>
      ) : (
        rows.map((def) => {
          const account = accountFor(def.id);
          const searchUrl = marketplaceSearchUrl(def, service, location);
          return (
            <IntegrationRow
              key={def.id}
              icon={def.glyph.icon}
              tone={def.glyph.tone}
              name={def.label}
              fact={factFor(def)}
              factDataAttr={`vendor-marketplace-fact-${def.id}`}
              dataAttr={`vendor-marketplace-row-${def.id}`}
              onOpen={() => openGuide(def)}
              action={
                <span className="flex items-center" onClick={stop} onKeyDown={stop} role="presentation">
                  <a
                    href={searchUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="grid size-9 place-items-center rounded-full text-foreground/80 hover:bg-foreground/5"
                    data-attr={`vendor-marketplace-search-${def.id}`}
                    aria-label={`Search ${def.label}`}
                    title={`Search ${def.label}`}
                    onClick={() => track("vendor_marketplace_action", { marketplace: def.id, action: "search", service })}
                  >
                    <Search className="size-[18px]" strokeWidth={1.75} aria-hidden />
                  </a>
                  <RecordActionContext.Provider
                    value={{
                      scope: `vendor-marketplace-${def.id}`,
                      clear: () => {},
                      actions: (
                        <>
                          <Button data-attr={`vendor-marketplace-menu-post-${def.id}`} onClick={() => openGuide(def)}>
                            Post a job
                          </Button>
                          <Button data-attr={`vendor-marketplace-menu-account-${def.id}`} onClick={() => setAccountModalId(def.id)}>
                            {account ? "Edit account" : "Add account"}
                          </Button>
                          {account ? (
                            <Button variant="danger" data-attr={`vendor-marketplace-menu-remove-${def.id}`} onClick={() => removeAccount(def)}>
                              Remove account
                            </Button>
                          ) : null}
                        </>
                      ),
                    }}
                  >
                    <RecordActionMenu label={def.label} activate={() => {}} />
                  </RecordActionContext.Provider>
                </span>
              }
            />
          );
        })
      )}

      {guideDef ? (
        <VendorMarketplaceGuide
          def={guideDef}
          service={service}
          location={location}
          account={accountFor(guideDef.id)}
          workspaceId={workspaceId}
          open
          onClose={() => setGuideId(null)}
          onAccountChanged={refresh}
        />
      ) : null}
      {accountDef ? (
        <VendorMarketplaceAccountModal
          def={accountDef}
          service={service}
          account={accountFor(accountDef.id)}
          workspaceId={workspaceId}
          open
          onClose={() => setAccountModalId(null)}
          onSaved={refresh}
        />
      ) : null}
    </div>
  );
}
