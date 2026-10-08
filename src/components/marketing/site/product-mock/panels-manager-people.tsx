"use client";

/**
 * Manager Residents and Vendors panels for the home demo, split out of `panels-manager-more.tsx` (which
 * re-exports them) so the pop-up work on these two tabs does not collide with Properties / Calendar.
 *
 * Each copies the real page, read from the code:
 *  - Residents (`pro-residents.tsx`): Potential · Current · Past, the Filter popover (Group by + Property), the round
 *    + that opens Add resident (the real wizard steps), a row that opens the resident's RECORD PAGE, and a ⋯ of
 *    Send setup · Remind to finish · Edit · Approve · Delete under the real conditions.
 *  - Vendors (`pro-vendors-panel.tsx`): Your vendors · PropLane vendors, the Settings gear on both tabs, the inline
 *    Filter panel on PropLane vendors, the round + that opens Add vendor, a row that opens the vendor's (or the
 *    catalog vendor's) RECORD PAGE.
 * Pop-ups and records load on demand (`demo-popups-lazy-people.tsx`). Nothing is sent, saved or fetched.
 */

import { useMemo, useState } from "react";
import { CalendarDays, FileCheck2, Filter, Mail, MapPin, Phone, Settings, ShieldCheck, Star, UserRound, Users, Wrench } from "lucide-react";
import { PortalApplicantRecordRow, PortalPropertyRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { DemoFilterSheet, portalFilterActiveCount } from "@/components/marketing/site/product-mock/demo-filter";
import { PortalListGroupFilterFields } from "@/components/portal/portal-list-group-filter-fields";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { portalListAddPrimaryLabel } from "@/components/portal/portal-list-control-stack";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { portalEmptyCopy, portalEmptyNoMatchTitle } from "@/lib/portal-empty-copy";
import { portalListGroupModeActiveCount, type PortalListGroupMode } from "@/lib/portal-list-grouping";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";
import {
  CATALOG_VENDORS,
  type CatalogVendorFixture,
  type ResidentFixtureRow,
} from "@/components/marketing/site/product-mock/fixtures";
import {
  DEMO_RATING_FLOORS,
  demoCatalogContact,
  demoResidentMessage,
  ratingOf,
  type DemoVendor,
} from "@/components/marketing/site/product-mock/fixtures-popups-people";
import { countBy, FixtureListScreen, matchesSearch } from "@/components/marketing/site/product-mock/panel-kit";
import { useRowSelection } from "@/components/marketing/site/product-mock/row-selection";
import { DEMO_PAGE_CLASS, PortalSidebarFixture, ProductWindow, useFixtureToast } from "@/components/marketing/site/product-mock/shared";
import {
  DemoApproveResidentPopup,
  DemoCatalogVendorRecord,
  DemoDialogPopup,
  DemoMessagePreviewPopup,
  DemoResidentActionPopup,
  DemoResidentRecord,
  DemoResidentWizardPopup,
  DemoVendorFormPopup,
  DemoVendorRecord,
} from "@/components/marketing/site/product-mock/demo-popups-lazy-people";
import { worldFor, type DemoStory } from "@/components/marketing/site/product-mock/world";

/* ───────────────────────────── Residents ───────────────────────────── */

const RESIDENT_TABS = [
  { id: "potential", label: "Potential" },
  { id: "current", label: "Current" },
  { id: "past", label: "Past" },
];

/** The real list opens on "Sort by house" (`RESIDENT_LIST_DEFAULT_GROUP_MODE`). */
const RESIDENT_LIST_DEFAULT_GROUP_MODE: PortalListGroupMode = "house";

type ResidentPopup =
  | { kind: "add" }
  | { kind: "edit" | "approve" | "setup" | "remind" | "delete" | "decline" | "run-check" | "payment-reminder"; row: ResidentFixtureRow }
  | { kind: "action"; action: "add-charge" | "add-service" | "add-tour" | "add-document"; row: ResidentFixtureRow };

const propertyOf = (row: ResidentFixtureRow) => row.place.split(" · ")[1] ?? row.place;

export function ResidentsPanel({ story }: { story?: DemoStory } = {}) {
  const { residents: RESIDENT_ROWS, story: progress } = worldFor(story);
  const jordan = progress.applicationSubmitted ? (progress.applicationApproved && progress.leaseStep === 3 ? "current" : "potential") : null;
  const [tab, setTab] = useState<ResidentFixtureRow["tab"]>(jordan ?? "current");
  const [lastJordan, setLastJordan] = useState(jordan);
  // The story moves Jordan between tabs; follow it when it does (set during render, not in an effect).
  if (jordan !== lastJordan) {
    setLastJordan(jordan);
    if (jordan !== null) setTab(jordan);
  }
  const [search, setSearch] = useState("");
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [groupMode, setGroupMode] = useState<PortalListGroupMode>(RESIDENT_LIST_DEFAULT_GROUP_MODE);
  const [record, setRecord] = useState<ResidentFixtureRow | null>(null);
  const [popup, setPopup] = useState<ResidentPopup | null>(null);
  const { show, node: toastNode } = useFixtureToast();
  const selection = useRowSelection();

  const counts = useMemo(() => countBy(RESIDENT_ROWS, (r) => r.tab, ["potential", "current", "past"]), [RESIDENT_ROWS]);
  const propertyOptions = useMemo(
    () => [...new Set(RESIDENT_ROWS.map(propertyOf))].sort().map((label) => ({ id: label, label })),
    [RESIDENT_ROWS],
  );
  const filtersActive = portalFilterActiveCount([propertyFilters, portalListGroupModeActiveCount(groupMode, RESIDENT_LIST_DEFAULT_GROUP_MODE)]);
  const rows = RESIDENT_ROWS.filter(
    (r) => r.tab === tab && matchesSearch(search, r.name, r.email, r.place) && (!propertyFilters.length || propertyFilters.includes(propertyOf(r))),
  ).sort((a, b) => (groupMode === "resident" ? a.name.localeCompare(b.name) : propertyOf(a).localeCompare(propertyOf(b)) || a.place.localeCompare(b.place)));

  const selectedRow = RESIDENT_ROWS.find((r) => r.id === selection.only);
  // The real conditions: Approve for a pending application, Send setup while there is no portal account,
  // Remind to finish for an incomplete application.
  const canApprove = (r: ResidentFixtureRow) => r.tab === "potential" && r.status === "Pending review";
  const needsSetup = (r: ResidentFixtureRow) => r.tab === "potential" || r.id === "res-luis";
  const canRemind = (r: ResidentFixtureRow) => r.tab === "potential" && r.status === "Incomplete application";
  const menuItems = (r: ResidentFixtureRow) => (
    <>
      {needsSetup(r) ? <DropdownMenuItem onSelect={() => setPopup({ kind: "setup", row: r })}>Send setup</DropdownMenuItem> : null}
      <DropdownMenuItem disabled={!canRemind(r)} onSelect={() => setPopup({ kind: "remind", row: r })}>
        Remind to finish
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => setPopup({ kind: "edit", row: r })}>Edit</DropdownMenuItem>
      <DropdownMenuSeparator />
      {canApprove(r) ? <DropdownMenuItem onSelect={() => setPopup({ kind: "approve", row: r })}>Approve</DropdownMenuItem> : null}
      <DropdownMenuItem className="text-danger" onSelect={() => setPopup({ kind: "delete", row: r })}>
        Delete
      </DropdownMenuItem>
    </>
  );

  const closePopup = () => setPopup(null);
  const done = (text: string) => {
    setPopup(null);
    show(`${text} (sample)`);
  };
  const recordAction = (id: string, row: ResidentFixtureRow) => {
    switch (id) {
      case "edit":
        return setPopup({ kind: "edit", row });
      case "delete":
        return setPopup({ kind: "delete", row });
      case "approve":
        return setPopup({ kind: "approve", row });
      case "decline":
        return setPopup({ kind: "decline", row });
      case "run-check":
        return setPopup({ kind: "run-check", row });
      case "remind-payment":
        return setPopup({ kind: "payment-reminder", row });
      case "add-charge":
        return setPopup({ kind: "action", action: "add-charge", row });
      case "add-service":
        return setPopup({ kind: "action", action: "add-service", row });
      case "add-tour":
        return setPopup({ kind: "action", action: "add-tour", row });
      case "upload":
        return setPopup({ kind: "action", action: "add-document", row });
      default:
        return show("Download PDF (sample)");
    }
  };

  const popups = (
    <>
      {popup?.kind === "add" ? <DemoResidentWizardPopup mode="add" onClose={closePopup} onDone={() => done("Resident added")} /> : null}
      {popup?.kind === "edit" ? <DemoResidentWizardPopup mode="edit" row={popup.row} onClose={closePopup} onDone={() => done("Resident saved")} /> : null}
      {popup?.kind === "approve" ? (
        <DemoApproveResidentPopup
          row={popup.row}
          onClose={closePopup}
          onApproved={() => {
            setPopup(null);
            show("Approved (sample)");
          }}
        />
      ) : null}
      {popup?.kind === "setup" || popup?.kind === "remind" ? (
        <DemoMessagePreviewPopup
          title={popup.kind === "setup" ? "Send setup" : "Remind to finish"}
          recipient={popup.row.email}
          phone="(206) 555-0100"
          subject={demoResidentMessage(popup.kind === "setup" ? "setup" : "remind", popup.row).subject}
          body={demoResidentMessage(popup.kind === "setup" ? "setup" : "remind", popup.row).body}
          confirmLabel={popup.kind === "setup" ? "Send setup" : "Send reminder"}
          onClose={closePopup}
          onConfirm={() => done(popup.kind === "setup" ? "Setup sent" : "Reminder sent")}
        />
      ) : null}
      {popup?.kind === "payment-reminder" ? (
        <DemoMessagePreviewPopup
          title="Send payment reminder"
          recipient={popup.row.email}
          subject="Rent reminder"
          body={`Hi ${popup.row.name.split(" ")[0]},\n\nA quick reminder that your rent for ${popup.row.place} is due soon. You can pay from Payments in your PropLane account.\n\nSeattle Homes`}
          confirmLabel="Send reminder"
          onClose={closePopup}
          onConfirm={() => done("Reminder sent")}
        />
      ) : null}
      {popup?.kind === "action" ? <DemoResidentActionPopup kind={popup.action} row={popup.row} onClose={closePopup} onDone={() => done(popup.action === "add-charge" ? "Charge added" : popup.action === "add-service" ? "Service added" : popup.action === "add-tour" ? "Tour added" : "Document added")} /> : null}
      {popup?.kind === "delete" ? (
        <DemoDialogPopup
          title="Delete resident"
          confirmLabel="Delete"
          tone="danger"
          onClose={closePopup}
          onConfirm={() => {
            const gone = popup.row;
            setPopup(null);
            setRecord(null);
            selection.clear();
            show(`${gone.name} deleted (sample)`);
          }}
        >
          <p>{popup.row.name} and their application, lease and charges will be removed. This cannot be undone.</p>
        </DemoDialogPopup>
      ) : null}
      {popup?.kind === "decline" ? (
        <DemoDialogPopup title="Decline application" confirmLabel="Decline" tone="danger" onClose={closePopup} onConfirm={() => done("Application declined")}>
          <p>{popup.row.name} will be told their application was declined.</p>
        </DemoDialogPopup>
      ) : null}
      {popup?.kind === "run-check" ? (
        <DemoDialogPopup title="Run background check" confirmLabel="Run check" onClose={closePopup} onConfirm={() => done("Background check ordered")}>
          <p>Order a credit, criminal and eviction check for {popup.row.name}.</p>
        </DemoDialogPopup>
      ) : null}
      {toastNode}
    </>
  );

  if (record) {
    return (
      <ProductWindow path={`/portal/residents/${record.tab}/${record.id}`}>
        <PortalSidebarFixture active="residents" />
        <div className={DEMO_PAGE_CLASS}>
          <DemoResidentRecord key={record.id} row={record} onBack={() => setRecord(null)} onAction={(id) => recordAction(id, record)} />
        </div>
        {popups}
      </ProductWindow>
    );
  }

  const filterSheet = (
    <DemoFilterSheet
      activeCount={filtersActive}
      compactPanel
      commandStripTrigger
      filterFieldCount={propertyOptions.length > 1 ? 2 : 1}
      constrainDropdownToTitleBand={false}
      mobileFlushBody
      onReset={() => {
        setPropertyFilters([]);
        setGroupMode(RESIDENT_LIST_DEFAULT_GROUP_MODE);
      }}
      dataAttr="residents-filter-sheet-open"
    >
      <PortalListGroupFilterFields
        groupMode={groupMode}
        onGroupModeChange={setGroupMode}
        propertyOptions={propertyOptions}
        propertyFilters={propertyFilters}
        onPropertyFiltersChange={setPropertyFilters}
        propertyDataAttr="residents-filter-property"
        groupModeDataAttr="residents-filter-group-mode"
      />
    </DemoFilterSheet>
  );

  return (
    <FixtureListScreen
      path={`/portal/residents/${tab}`}
      sidebar={<PortalSidebarFixture active="residents" />}
      title="Residents"
      tabs={RESIDENT_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
      activeId={tab}
      onTab={(id) => {
        setTab(id as ResidentFixtureRow["tab"]);
        selection.clear();
      }}
      tabAriaLabel="Resident lists"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search residents"
      actions={filterSheet}
      primary={{ label: portalListAddPrimaryLabel("resident"), onClick: () => setPopup({ kind: "add" }) }}
      isEmpty={rows.length === 0}
      emptyTitle={
        rows.length === 0 && counts[tab] > 0 && (search.trim() || propertyFilters.length)
          ? portalEmptyNoMatchTitle("residents", search)
          : portalEmptyCopy(`residents.${tab}`).title
      }
      emptySection="residents"
      menu={selectedRow ? menuItems(selectedRow) : undefined}
      onBulkClear={selection.clear}
      overlay={popups}
    >
      {rows.map((r) => (
        <PortalApplicantRecordRow
          key={r.id}
          name={r.name}
          address={r.place}
          facts={
            <>
              <PortalRowFact icon={Mail}>{r.email}</PortalRowFact>
              {r.shared ? <PortalRowFact icon={Users}>{r.shared}</PortalRowFact> : null}
              <PortalRowFact icon={CalendarDays}>{r.leaseStart}</PortalRowFact>
              {r.status ? <span className="truncate">{r.status}</span> : null}
            </>
          }
          checked={selection.isChecked(r.id)}
          onSelectedChange={(checked) => selection.set(r.id, checked)}
          selectLabel={r.name}
          onOpen={() => {
            selection.clear();
            setRecord(r);
          }}
          dataAttr="resident-list-row"
        />
      ))}
    </FixtureListScreen>
  );
}

/* ───────────────────────────── Vendors ───────────────────────────── */

const VENDOR_TABS = [
  { id: "yours", label: "Your vendors" },
  { id: "catalog", label: "PropLane vendors" },
];

/** Which words in a catalog vendor's trades answer to each of the real trade options. */
const TRADE_WORDS: Record<string, string[]> = {
  "General maintenance": ["handyman", "carpentry", "maintenance"],
  Plumbing: ["plumbing"],
  Electrical: ["electrical"],
  HVAC: ["hvac", "heating"],
  "Appliance repair": ["appliance"],
  Landscaping: ["landscaping"],
  Cleaning: ["cleaning"],
  "Pest control": ["pest"],
  Other: ["painting"],
};
const tradeMatches = (trades: string, selected: string) => (TRADE_WORDS[selected] ?? [selected.toLowerCase()]).some((word) => trades.toLowerCase().includes(word));

type VendorPopup =
  | { kind: "add" }
  | { kind: "edit" | "invite" | "remove"; vendor: DemoVendor }
  | { kind: "catalog-invite" | "catalog-confirm"; catalog: CatalogVendorFixture }
  | { kind: "invite-message"; name: string; email: string; phone: string };

export function VendorsPanel({ story }: { story?: DemoStory } = {}) {
  const { vendors: VENDOR_ROWS } = worldFor(story);
  const [tab, setTab] = useState("yours");
  const [search, setSearch] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [tradeFilter, setTradeFilter] = useState("");
  const [areaFilter, setAreaFilter] = useState("");
  const [ratingFilter, setRatingFilter] = useState("");
  const [addedIds, setAddedIds] = useState<string[]>([]);
  const [vendorRecord, setVendorRecord] = useState<DemoVendor | null>(null);
  const [catalogRecord, setCatalogRecord] = useState<CatalogVendorFixture | null>(null);
  const [popup, setPopup] = useState<VendorPopup | null>(null);
  const { show, node: toastNode } = useFixtureToast();
  const selection = useRowSelection();

  // A PropLane vendor you add joins Your vendors.
  const roster: DemoVendor[] = useMemo(
    () => [
      ...VENDOR_ROWS,
      ...CATALOG_VENDORS.filter((c) => addedIds.includes(c.id)).map((c): DemoVendor => {
        const contact = demoCatalogContact(c);
        return { id: `vendor-${c.id}`, name: c.name, trade: contact.trade, phone: contact.phone, email: contact.email, rating: c.rating, services: 0 };
      }),
    ],
    [VENDOR_ROWS, addedIds],
  );
  const filterActive = Boolean(tradeFilter || areaFilter.trim() || ratingFilter);
  const yours = roster.filter((v) => matchesSearch(search, v.name, v.trade, v.email));
  const catalog = CATALOG_VENDORS.filter(
    (v) =>
      matchesSearch(search, v.name, v.trades, v.city) &&
      (!tradeFilter || tradeMatches(v.trades, tradeFilter)) &&
      (!areaFilter.trim() || v.city.toLowerCase().includes(areaFilter.trim().toLowerCase())) &&
      (!ratingFilter || ratingOf(v.rating) >= Number(ratingFilter)),
  );
  const rows = tab === "yours" ? yours : catalog;
  const selectedYours = roster.find((v) => v.id === selection.only);
  const selectedCatalog = CATALOG_VENDORS.find((v) => v.id === selection.only);

  const closePopup = () => setPopup(null);
  const done = (text: string) => {
    setPopup(null);
    show(`${text} (sample)`);
  };
  const inviteMessage = (name: string, email: string, phone: string) => setPopup({ kind: "invite-message", name, email, phone });
  const addCatalogVendor = (catalog: CatalogVendorFixture) => {
    setAddedIds((ids) => (ids.includes(catalog.id) ? ids : [...ids, catalog.id]));
    setPopup(null);
    show("Added to your vendors (sample)");
  };
  const rosterFor = (catalog: CatalogVendorFixture) => roster.find((v) => v.id === `vendor-${catalog.id}`);

  const yoursMenu = selectedYours ? (
    <>
      <DropdownMenuItem onSelect={() => setPopup({ kind: "edit", vendor: selectedYours })}>Edit</DropdownMenuItem>
      <DropdownMenuItem className="text-danger" onSelect={() => setPopup({ kind: "remove", vendor: selectedYours })}>
        Remove
      </DropdownMenuItem>
    </>
  ) : undefined;
  const catalogMenu = selectedCatalog ? (
    <DropdownMenuItem disabled={addedIds.includes(selectedCatalog.id)} onSelect={() => setPopup({ kind: "catalog-confirm", catalog: selectedCatalog })}>
      {addedIds.includes(selectedCatalog.id) ? "Added" : "Add to your vendors"}
    </DropdownMenuItem>
  ) : undefined;

  const popups = (
    <>
      {popup?.kind === "add" ? (
        <DemoVendorFormPopup mode="add" onClose={closePopup} onFinish={(r) => inviteMessage(r.name || "Vendor", r.email, r.phone)} />
      ) : null}
      {popup?.kind === "edit" ? (
        <DemoVendorFormPopup
          mode="edit"
          vendor={popup.vendor}
          onClose={closePopup}
          onFinish={() => done("Vendor saved")}
          onDelete={() => setPopup({ kind: "remove", vendor: popup.vendor })}
        />
      ) : null}
      {popup?.kind === "catalog-invite" ? (
        <DemoVendorFormPopup mode="add" catalog={popup.catalog} onClose={closePopup} onFinish={(r) => inviteMessage(r.name, r.email, r.phone)} />
      ) : null}
      {popup?.kind === "catalog-confirm" ? (
        <DemoDialogPopup title="Add to your vendors" confirmLabel="Add to your vendors" onClose={closePopup} onConfirm={() => addCatalogVendor(popup.catalog)}>
          <p>
            {popup.catalog.name} will be added to your roster and will be able to see this workspace&apos;s service requests so they can bid and get assigned jobs.
          </p>
        </DemoDialogPopup>
      ) : null}
      {popup?.kind === "invite-message" ? (
        <DemoMessagePreviewPopup
          title="New message"
          recipient={popup.name}
          phone={popup.phone}
          subject="You are invited to PropLane"
          body={`Hi ${popup.name.split(" ")[0]},\n\nSeattle Homes would like to work with you on PropLane. Create your free account to see service requests, send bids and get paid.\n\nhttps://proplane.ai/auth/create-account?role=vendor\n\nSeattle Homes`}
          confirmLabel="Send invite"
          onClose={closePopup}
          onConfirm={() => {
            const found = CATALOG_VENDORS.find((c) => c.name === popup.name);
            if (found) addCatalogVendor(found);
            else done("Invite sent");
          }}
        />
      ) : null}
      {popup?.kind === "invite" ? (
        <DemoMessagePreviewPopup
          title="New message"
          recipient={popup.vendor.name}
          phone={popup.vendor.phone}
          subject="You are invited to PropLane"
          body={`Hi ${popup.vendor.name.split(" ")[0]},\n\nSeattle Homes would like to work with you on PropLane. Create your free account to see service requests, send bids and get paid.\n\nhttps://proplane.ai/auth/create-account?role=vendor\n\nSeattle Homes`}
          confirmLabel="Send invite"
          onClose={closePopup}
          onConfirm={() => done("Invite sent")}
        />
      ) : null}
      {popup?.kind === "remove" ? (
        <DemoMessagePreviewPopup
          title="Remove vendor — notification preview"
          recipient={popup.vendor.email}
          phone={popup.vendor.phone}
          subject="You were removed from Seattle Homes on PropLane"
          body={`Hi ${popup.vendor.name.split(" ")[0]},\n\nSeattle Homes removed you from their vendors on PropLane, so you will no longer receive their service requests.\n\nSeattle Homes`}
          confirmLabel="Remove & send message"
          onClose={closePopup}
          onConfirm={() => {
            const gone = popup.vendor;
            setPopup(null);
            setVendorRecord(null);
            selection.clear();
            show(`${gone.name} removed (sample)`);
          }}
        />
      ) : null}
      {toastNode}
    </>
  );

  if (vendorRecord) {
    return (
      <ProductWindow path={`/portal/vendors/${vendorRecord.id}`}>
        <PortalSidebarFixture active="vendors" />
        <div className={DEMO_PAGE_CLASS}>
          <DemoVendorRecord
            key={vendorRecord.id}
            vendor={vendorRecord}
            onBack={() => setVendorRecord(null)}
            onAction={(id) => {
              if (id === "edit") setPopup({ kind: "edit", vendor: vendorRecord });
              else if (id === "invite") setPopup({ kind: "invite", vendor: vendorRecord });
              else if (id === "remove") setPopup({ kind: "remove", vendor: vendorRecord });
            }}
          />
        </div>
        {popups}
      </ProductWindow>
    );
  }

  if (catalogRecord) {
    const matched = rosterFor(catalogRecord);
    return (
      <ProductWindow path={`/portal/vendors/catalog/${catalogRecord.id}`}>
        <PortalSidebarFixture active="vendors" />
        <div className={DEMO_PAGE_CLASS}>
          <DemoCatalogVendorRecord
            key={catalogRecord.id}
            vendor={catalogRecord}
            added={Boolean(matched)}
            onBack={() => setCatalogRecord(null)}
            onAction={(id) => {
              if (id !== "add") return;
              if (!matched) {
                setPopup({ kind: "catalog-invite", catalog: catalogRecord });
                return;
              }
              // Added already: the header reads "Open" and goes to the vendor on your roster.
              setCatalogRecord(null);
              setTab("yours");
              setVendorRecord(matched);
            }}
          />
        </div>
        {popups}
      </ProductWindow>
    );
  }

  const filterPanel =
    tab === "catalog" && filterOpen ? (
      <div className="mb-3 flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-card p-3" data-attr="vendor-directory-filter-panel">
        <div className="min-w-[10rem]">
          <FieldSingleSelect
            label="Trade"
            value={tradeFilter}
            onChange={setTradeFilter}
            options={[{ value: "", label: "Any trade" }, ...VENDOR_TRADE_OPTIONS.map((t) => ({ value: t, label: t }))]}
            dataAttr="vendor-directory-filter-trade"
          />
        </div>
        <div className="min-w-[10rem]">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted" htmlFor="vendor-directory-filter-area">
            Area
          </label>
          <Input
            id="vendor-directory-filter-area"
            value={areaFilter}
            onChange={(e) => setAreaFilter(e.target.value)}
            placeholder="City or ZIP"
            data-attr="vendor-directory-filter-area"
          />
        </div>
        <div className="min-w-[10rem]">
          <FieldSingleSelect label="Rating" value={ratingFilter} onChange={setRatingFilter} options={DEMO_RATING_FLOORS} dataAttr="vendor-directory-filter-rating" />
        </div>
        {filterActive ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setTradeFilter("");
              setAreaFilter("");
              setRatingFilter("");
            }}
            data-attr="vendor-directory-filter-reset"
          >
            Reset
          </Button>
        ) : null}
      </div>
    ) : null;

  const noMatch = rows.length === 0 && (search.trim() || (tab === "catalog" && filterActive));
  const emptyTitle = noMatch ? portalEmptyNoMatchTitle("vendors", search) : portalEmptyCopy(tab === "catalog" ? "vendors.catalog" : "vendors").title;

  return (
    <FixtureListScreen
      path="/portal/vendors"
      sidebar={<PortalSidebarFixture active="vendors" />}
      title="Vendors"
      tabs={[
        { ...VENDOR_TABS[0]!, count: roster.length },
        { ...VENDOR_TABS[1]!, count: CATALOG_VENDORS.length },
      ]}
      activeId={tab}
      onTab={(id) => {
        setTab(id);
        selection.clear();
      }}
      tabAriaLabel="Vendor lists"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search vendors"
      actions={
        <>
          {tab === "catalog" ? (
            <PortalIconAction
              label={`Filter by trade or rating${filterActive ? " · active" : ""}`}
              icon={Filter}
              active={filterOpen || filterActive}
              onClick={() => setFilterOpen((v) => !v)}
              data-attr="vendor-directory-filter-toggle"
            />
          ) : null}
          <PortalIconAction icon={Settings} label="Vendor defaults" onClick={() => show("Vendor defaults (sample)")} data-attr="vendors-settings-gear" />
        </>
      }
      primary={{ label: portalListAddPrimaryLabel("vendor"), onClick: () => setPopup({ kind: "add" }) }}
      isEmpty={false}
      emptyTitle={emptyTitle}
      emptySection="vendors"
      surface={false}
      overlay={popups}
    >
      {filterPanel}
      <PortalRecordListSurface
        className="mt-0"
        isEmpty={rows.length === 0}
        emptyCard={{ title: emptyTitle, section: "vendors" }}
        bulkActions={tab === "yours" ? yoursMenu : catalogMenu}
        onBulkClear={selection.clear}
      >
        {tab === "yours"
          ? yours.map((v) => (
              <PortalApplicantRecordRow
                key={v.id}
                name={v.name}
                address={v.trade}
                facts={
                  <>
                    <PortalRowFact icon={Phone}>{v.phone}</PortalRowFact>
                    <PortalRowFact icon={Mail}>{v.email}</PortalRowFact>
                    {v.rating ? <PortalRowFact icon={Star}>{v.rating}</PortalRowFact> : null}
                    {v.rank ? <span className="truncate">{v.rank}</span> : null}
                  </>
                }
                amount={v.services > 0 ? `${v.services} ${v.services === 1 ? "service" : "services"}` : undefined}
                checked={selection.isChecked(v.id)}
                onSelectedChange={(checked) => selection.set(v.id, checked)}
                selectLabel={v.name}
                onOpen={() => {
                  selection.clear();
                  setVendorRecord(v);
                }}
                dataAttr="vendor-list-row"
              />
            ))
          : catalog.map((v) => (
              <PortalPropertyRecordRow
                key={v.id}
                title={v.name}
                leading={
                  <span className="flex h-[66px] w-[88px] shrink-0 items-center justify-center rounded-[10px] bg-secondary text-primary" aria-hidden>
                    <UserRound className="size-[22px]" strokeWidth={1.5} />
                  </span>
                }
                facts={
                  <>
                    <PortalRowFact icon={Wrench}>{v.trades}</PortalRowFact>
                    <PortalRowFact icon={MapPin}>{v.city}</PortalRowFact>
                    <PortalRowFact icon={ShieldCheck}>Insured</PortalRowFact>
                    <PortalRowFact icon={FileCheck2}>Licensed</PortalRowFact>
                    <PortalRowFact icon={Star}>{v.rating}</PortalRowFact>
                  </>
                }
                checked={selection.isChecked(v.id)}
                onSelectedChange={(checked) => selection.set(v.id, checked)}
                selectLabel={v.name}
                onOpen={() => {
                  selection.clear();
                  setCatalogRecord(v);
                }}
                dataAttr="vendor-catalog-row"
              />
            ))}
      </PortalRecordListSurface>
    </FixtureListScreen>
  );
}
