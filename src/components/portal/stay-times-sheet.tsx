"use client";

/**
 * Check-in and checkout: the sheet a guest opens from a stay's ⋯ menu (or from the text link
 * `?stay=<id>&addOn=early_check_in&time=12:00`). A content-sized bottom sheet on a phone, a dialog on
 * desktop. It shows the stay's two times and, for each paid add-on the server says is available, one row
 * "Early check-in · 12:00 pm · $25" with an Add button (the Button owns its loading: it returns the POST,
 * then sends the guest to Stripe's hosted page). A paid one reads "Paid"; an add-on that is unavailable is
 * not drawn at all, and when neither is available the sheet is just the two times. Prices and times come
 * from the server (the property's own settings); nothing here decides them. See docs/agents/bookings.md.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { formatStayMoment } from "@/lib/bookings/stay-times";
import { ConfirmRows, PortalDialog } from "@/components/portal/portal-dialog";
import { Button } from "@/components/ui/button";
import {
  GUEST_STAYS_CHANGED,
  GuestStaysError,
  fetchStayAddOns,
  postStayAddOn,
  type StayAddOnsView,
} from "@/lib/short-stay/guest-stays-client";
import { stayAddOnRowViews, type StayAddOnLink } from "@/lib/short-stay/stay-add-ons";
import type { GuestStay } from "@/lib/short-stay/guest-stays";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; view: StayAddOnsView };

export function StayTimesSheet({
  stay,
  preselect = null,
  onClose,
  onChanged,
}: {
  stay: Pick<GuestStay, "id" | "propertyLabel" | "roomLabel">;
  /** The text link's `addOn`, drawn selected so the guest lands on the row they were sent for. */
  preselect?: Pick<StayAddOnLink, "addOn"> | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [error, setError] = useState("");
  const focused = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setLoad({ status: "ready", view: await fetchStayAddOns(stay.id) });
    } catch (caught) {
      setLoad({ status: "error", message: caught instanceof Error ? caught.message : "Could not load this stay." });
    }
  }, [stay.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data load on open; state is set after the awaited fetch
    void refresh();
  }, [refresh]);

  const add = async (kind: "early_check_in" | "late_check_out", time?: string) => {
    setError("");
    try {
      const result = await postStayAddOn(stay.id, { kind, time });
      window.dispatchEvent(new Event(GUEST_STAYS_CHANGED));
      onChanged();
      const destination = result.checkoutUrl ?? result.paymentsPath;
      if (result.status === "pending" && destination) {
        window.location.assign(destination);
        return;
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof GuestStaysError || caught instanceof Error ? caught.message : "Could not save that.");
      await refresh();
    }
  };

  const view = load.status === "ready" ? load.view : null;
  const rows = view ? stayAddOnRowViews(view.rows) : [];
  const offered = (kind: string) => view?.rows.find((row) => row.kind === kind)?.offer.time;

  // The link's row takes focus once, after the rows draw.
  useEffect(() => {
    if (!view || !preselect?.addOn || focused.current) return;
    focused.current = true;
    document.querySelector<HTMLElement>(`[data-attr="stay-add-on-${preselect.addOn}"] button`)?.focus();
  }, [view, preselect]);

  return (
    <PortalDialog
      open
      onClose={onClose}
      title="Check-in and checkout"
      dataAttr="stay-times-sheet"
      primaryAction={null}
      fullScreenMobile={false}
    >
      {load.status === "loading" ? (
        <p className="text-[14px] text-muted" role="status">Loading</p>
      ) : load.status === "error" ? (
        <p className="text-danger" role="alert" data-attr="stay-times-error">{load.message}</p>
      ) : view ? (
        <div className="space-y-4" data-attr="stay-times-body">
          <ConfirmRows
            rows={[
              { label: "Check-in", value: formatStayMoment(view.stay.checkIn, view.stay.checkInTime) },
              { label: "Check-out", value: formatStayMoment(view.stay.checkOut, view.stay.checkOutTime) },
            ]}
          />
          {rows.length > 0 ? (
            <ul className="divide-y divide-border rounded-xl border border-border" data-attr="stay-add-on-rows">
              {rows.map((row) => (
                <li
                  key={row.kind}
                  data-attr={`stay-add-on-${row.kind}`}
                  data-selected={preselect?.addOn === row.kind ? "" : undefined}
                  className={[
                    "flex min-h-[44px] items-center justify-between gap-3 px-3.5 py-2.5 text-[15px] sm:text-[14px]",
                    preselect?.addOn === row.kind ? "bg-primary/[0.06]" : "",
                  ].join(" ")}
                >
                  <span className="min-w-0">{row.text}</span>
                  {row.action ? (
                    <Button
                      type="button"
                      variant="outline"
                      data-attr={`stay-add-on-${row.kind}-${row.action}`}
                      onClick={() => add(row.kind, offered(row.kind))}
                    >
                      {row.action === "pay" ? "Pay" : "Add"}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {error ? <p className="text-danger" role="alert" data-attr="stay-times-error">{error}</p> : null}
        </div>
      ) : null}
    </PortalDialog>
  );
}
