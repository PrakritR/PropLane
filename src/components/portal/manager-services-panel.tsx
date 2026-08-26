"use client";

import { useEffect, useMemo, useState } from "react";
import { PortalEmptyState } from "@/components/portal/portal-empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ManagerPortalFilterRow, ManagerPortalPageShell, PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import {
  deleteAmenityOffer,
  readAmenityOffersForProperty,
  saveAmenityOffer,
  toggleAmenityOfferAvailability,
  type ManagerAmenityOffer,
} from "@/lib/manager-amenity-catalog-storage";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";

const EMPTY_FORM = { name: "", description: "", price: "", deposit: "" };

export function ManagerServicesPanel() {
  const { showToast } = useAppUi();
  const { userId: managerUserId, ready: authReady } = useManagerUserId();
  const [offersTick, setOffersTick] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingOffer, setEditingOffer] = useState<ManagerAmenityOffer | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [selectedPropertyId, setSelectedPropertyId] = useState("");
  const [propertyTick, setPropertyTick] = useState(0);

  const propertyOptions = useMemo(() => {
    void propertyTick;
    return buildManagerPropertyFilterOptions(managerUserId ?? null);
  }, [managerUserId, propertyTick]);

  const resolvedPropertyId = useMemo(() => {
    if (propertyOptions.length === 0) return "";
    if (selectedPropertyId && propertyOptions.some((option) => option.id === selectedPropertyId)) {
      return selectedPropertyId;
    }
    return propertyOptions[0]!.id;
  }, [propertyOptions, selectedPropertyId]);

  const offers = useMemo(() => {
    void offersTick;
    if (managerUserId && resolvedPropertyId) {
      return readAmenityOffersForProperty(managerUserId, resolvedPropertyId);
    }
    return [];
  }, [managerUserId, resolvedPropertyId, offersTick]);

  useEffect(() => {
    if (!authReady || !managerUserId) return;
    void syncPropertyPipelineFromServer().then(() => setPropertyTick((t) => t + 1));
  }, [authReady, managerUserId]);

  const reload = () => setOffersTick((t) => t + 1);

  const openCreate = () => {
    setEditingOffer(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  };

  const openEdit = (offer: ManagerAmenityOffer) => {
    setEditingOffer(offer);
    setForm({ name: offer.name, description: offer.description, price: offer.price, deposit: offer.deposit ?? "" });
    setModalOpen(true);
  };

  const handleSave = () => {
    if (!form.name.trim()) { showToast("Request name is required."); return; }
    if (!managerUserId) { showToast("Sign in first."); return; }
    const offer: ManagerAmenityOffer = {
      id: editingOffer?.id ?? `offer-${Date.now()}`,
      name: form.name.trim(),
      description: form.description.trim(),
      price: form.price.trim(),
      deposit: form.deposit.trim(),
      category: "",
      available: editingOffer?.available ?? true,
      managerUserId,
      propertyId: resolvedPropertyId || undefined,
      createdAt: editingOffer?.createdAt ?? new Date().toISOString(),
    };
    saveAmenityOffer(offer);
    reload();
    showToast(editingOffer ? "Request option updated." : "Request option added to catalog.");
    setModalOpen(false);
  };

  const handleDelete = (offer: ManagerAmenityOffer) => {
    if (!window.confirm(`Remove "${offer.name}" from your catalog?`)) return;
    if (!managerUserId) return;
    deleteAmenityOffer(offer.id, managerUserId);
    reload();
    showToast("Request option removed.");
  };

  const handleToggle = (offer: ManagerAmenityOffer) => {
    if (!managerUserId) return;
    toggleAmenityOfferAvailability(offer.id, managerUserId);
    reload();
    showToast(offer.available ? "Request option paused. Residents won't see it." : "Request option is now available to residents.");
  };

  return (
    <>
      <ManagerPortalPageShell
        title="Services catalog"
        titleAside={
          <Button type="button" variant="outline" className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN}`} onClick={openCreate}>
            Add
          </Button>
        }
        filterRow={
          propertyOptions.length > 0 ? (
            <ManagerPortalFilterRow>
              <PortalFilterSortSheet
                activeCount={portalFilterActiveCount([resolvedPropertyId])}
                compactPanel
                filterFieldCount={1}
                constrainDropdownToTitleBand
                mobileFlushBody
                className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
                onReset={() => setSelectedPropertyId("")}
                dataAttr="services-catalog-filter-sheet-open"
              >
                <ApplicationFilterSortFields
                  propertyOptions={propertyOptions}
                  propertyFilters={resolvedPropertyId ? [resolvedPropertyId] : []}
                  onPropertyFiltersChange={(ids) => setSelectedPropertyId(ids[0] ?? "")}
                  allLabel="Select a property"
                  selectionMode="single"
                  dataAttr="services-catalog-filter-property"
                />
              </PortalFilterSortSheet>
            </ManagerPortalFilterRow>
          ) : null
        }
      >
        <div className="mt-1">
            {!resolvedPropertyId ? (
              <p className="py-8 text-center text-sm text-muted">Select a property to manage its request options.</p>
            ) : offers.length === 0 ? (
              <div className="space-y-5">
                <PortalEmptyState title="No request options yet." icon="service" />
                <div className="flex justify-center">
                  <Button type="button" className="rounded-full" onClick={openCreate}>
                    Add first request
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {offers.map((offer) => (
                  <div
                    key={offer.id}
                    className={`flex flex-col rounded-2xl border bg-card p-4 shadow-[0_1px_4px_rgba(15,23,42,0.06)] transition ${
                      offer.available ? "border-border" : "border-border opacity-60"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-foreground">{offer.name}</p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        {offer.price ? (
                          <span className="rounded-full bg-accent/30 px-2.5 py-0.5 text-xs font-semibold text-muted">
                            {offer.price}
                          </span>
                        ) : null}
                        {offer.deposit ? (
                          <span className="rounded-full px-2.5 py-0.5 text-xs font-semibold portal-badge-pending ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]">
                            Deposit {offer.deposit}
                          </span>
                        ) : null}
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${
                            offer.available
                              ? "portal-badge-success ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]"
                              : "bg-accent/30 text-muted ring-border"
                          }`}
                        >
                          {offer.available ? "Available" : "Paused"}
                        </span>
                      </div>
                    </div>
                    {offer.description ? (
                      <p className="mt-2 text-xs leading-relaxed text-muted">{offer.description}</p>
                    ) : null}
                    <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
                      <button
                        type="button"
                        onClick={() => openEdit(offer)}
                        className="rounded-full border border-border bg-card px-3 py-1 text-[11px] font-semibold text-muted transition hover:bg-accent/30"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggle(offer)}
                        className="rounded-full border border-border bg-card px-3 py-1 text-[11px] font-semibold text-muted transition hover:bg-accent/30"
                      >
                        {offer.available ? "Pause" : "Resume"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(offer)}
                        className="rounded-full border border-rose-200 bg-card px-3 py-1 text-[11px] font-semibold text-rose-700 transition hover:bg-[var(--status-overdue-bg)]"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
      </ManagerPortalPageShell>

      <Modal
        open={modalOpen}
        title={editingOffer ? "Edit service option" : "Add service option"}
        onClose={() => setModalOpen(false)}
        footer={
          <ModalFooter>
            <Button type="button" variant="primary" className="rounded-full" onClick={handleSave}>
              {editingOffer ? "Save changes" : "Add service"}
            </Button>
          </ModalFooter>
        }
      >
        <div className="grid gap-3">
          <div>
            <p className="mb-1 text-[11px] font-medium text-muted">Request name</p>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Weekly cleaning, Blanket set"
              className="bg-card"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted">Price</p>
              <Input
                value={form.price}
                onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                placeholder="e.g. $25, $80/month, Free"
                className="bg-card"
              />
            </div>
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted">Deposit</p>
              <Input
                value={form.deposit}
                onChange={(e) => setForm((f) => ({ ...f, deposit: e.target.value }))}
                placeholder="e.g. $50"
                className="bg-card"
              />
            </div>
          </div>
          <div>
            <p className="mb-1 text-[11px] font-medium text-muted">Description</p>
            <textarea
              rows={3}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="What's included, how it works, any conditions…"
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-200"
            />
          </div>
        </div>
      </Modal>
    </>
  );
}
