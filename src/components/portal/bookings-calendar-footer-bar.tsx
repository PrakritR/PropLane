"use client";

import { Button } from "@/components/ui/button";
import { PORTAL_DETAIL_BTN } from "@/components/portal/portal-data-table";
import { PortalFormSingleSelect } from "@/components/portal/filter-field-lists";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { PortalPageFooterActions } from "@/components/portal/portal-section-action-row";

type BookingsRoomOption = { id: string; label: string };

/**
 * Pinned footer for Bookings calendars — room filter (when rent-by-room) opens the
 * standard portal filter sheet; Link Airbnb stays one tap away on every breakpoint.
 */
export function BookingsCalendarFooterBar({
  rooms,
  roomFilterId = "",
  onRoomFilterIdChange,
  onLinkAirbnb,
  linkAirbnbDisabled = false,
  linkAirbnbDataAttr = "property-bookings-link-airbnb",
  roomFilterDataAttr = "property-bookings-room-filter-sheet-open",
}: {
  rooms?: BookingsRoomOption[];
  roomFilterId?: string;
  onRoomFilterIdChange?: (next: string) => void;
  onLinkAirbnb: () => void;
  linkAirbnbDisabled?: boolean;
  linkAirbnbDataAttr?: string;
  roomFilterDataAttr?: string;
}) {
  const showRoomFilter = Boolean(rooms && rooms.length > 1 && onRoomFilterIdChange);

  const roomFilterSheet = showRoomFilter ? (
    <PortalFilterSortSheet
      activeCount={portalFilterActiveCount([roomFilterId])}
      compactPanel
      filterFieldCount={1}
      constrainDropdownToTitleBand={false}
      mobileFlushBody
      className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
      onReset={() => onRoomFilterIdChange!("")}
      dataAttr={roomFilterDataAttr}
    >
      <PortalFormSingleSelect
        label="Room"
        value={roomFilterId}
        onChange={onRoomFilterIdChange!}
        options={[
          { value: "", label: "All rooms" },
          ...rooms!.map((room) => ({ value: room.id, label: room.label })),
        ]}
        placeholder="All rooms"
        dataAttr="property-bookings-room-filter"
      />
    </PortalFilterSortSheet>
  ) : null;

  return (
    <PortalPageFooterActions pinned rowVariant="header">
      <div className="flex w-full min-w-0 flex-nowrap items-center justify-start gap-2">
        {roomFilterSheet}
        <Button
          type="button"
          variant="outline"
          className={PORTAL_DETAIL_BTN}
          data-attr={linkAirbnbDataAttr}
          disabled={linkAirbnbDisabled}
          onClick={onLinkAirbnb}
        >
          Link Airbnb
        </Button>
      </div>
    </PortalPageFooterActions>
  );
}
